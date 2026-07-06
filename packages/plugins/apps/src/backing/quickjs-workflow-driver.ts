import { Effect } from "effect";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import {
  WorkflowError,
  type DriveOutcome,
  type SuspendMarker,
  type WorkflowBridge,
  type WorkflowBridgeResult,
  type WorkflowDriver,
} from "../seams/workflow-runner";
import type { ArtifactStore, SnapshotId } from "../seams/artifact-store";
import { bundleEntry } from "../pipeline/bundle";

// ---------------------------------------------------------------------------
// QuickJS-backed WorkflowDriver (self-hosted).
//
// The author's `defineWorkflow({ run(step, { db }) })` body runs INSIDE QuickJS
// on every replay (the same isolation the tool handlers use), NOT in-process.
// Each `step.*` / `db.sql` call crosses the single `__wf` bridge to the host,
// which services it against the journal (`WorkflowBridge`). This is what makes
// the orchestrator substrate-neutral: everything crossing the boundary is JSON,
// so the cloud backing can be an RPC.
//
// The shim's `__runWorkflow()` returns a STRUCTURED envelope, never throws a
// string-matched sentinel:
//   { status: "completed", output }
//   { status: "suspended", marker: { suspend: "sleep" | "event", event? } }
//   { status: "failed", retryable, message, retryAfter? }
// so the runner reads typed fields (retryable-vs-fatal is a discriminator, the
// suspend marker is structured), never `error.includes("...")`.
// ---------------------------------------------------------------------------

const WORKFLOW_TIMEOUT_MS = 60_000;

/** True if a host bridge result is a structured suspend (vs a plain value). */
const isSuspend = (r: WorkflowBridgeResult): r is SuspendMarker => "suspend" in r;

// The workflow shim: a `step` facade + a `db` client, both routing through the
// `__wf` bridge, plus `__runWorkflow` that drives the authored body and returns
// the structured envelope. `globalThis.__artifact` is set by the compiled
// bundle (the workflow def). Kept as a plain string (QuickJS evals a string).
const workflowShim = (input: unknown): string => `
var __wfInput = ${JSON.stringify(input ?? {})};
var __wf = function(op) { return tools.__wf(op); };
// A tagged suspension we throw to unwind the body; caught by __runWorkflow and
// turned into a structured { status: "suspended" } (no string-matching).
function __Suspend(marker) { this.__wfSuspend = marker; }
var __await = async function(op) {
  var res = await __wf(op);
  if (res && res.suspend) throw new __Suspend({ suspend: res.suspend, event: res.event });
  if (res && res.error) {
    // A structured step error (e.g. step.tool's bound tool threw). Re-throw with
    // the typed retryable discriminator so __runWorkflow classifies the run.
    var err = new Error(res.error.message);
    err.retryable = res.error.retryable === true;
    if (typeof res.error.retryAfter === "number") err.retryAfter = res.error.retryAfter;
    throw err;
  }
  return res.value;
};
var step = {
  do: async function(name, fn) {
    var j = await __wf({ kind: "step.check", step: name });
    if (j && j.value && j.value.journaled) return j.value.output;
    var value = await fn();
    await __wf({ kind: "step.record", step: name, value: value === undefined ? null : value });
    return value;
  },
  tool: async function(address, args) {
    return __await({ kind: "step.tool", step: "tool:" + address, address: address, args: args || {} });
  },
  sleep: async function(name, ms) { await __await({ kind: "step.sleep", step: "sleep:" + name, ms: ms }); },
  waitForEvent: async function(name, opts) {
    return __await({ kind: "step.waitForEvent", step: "wait:" + name });
  },
  notify: async function(msg) { await __wf({ kind: "step.notify", msg: msg }); },
};
var __db = {
  sql: function(strings) {
    var values = Array.prototype.slice.call(arguments, 1);
    var sql = "";
    for (var i = 0; i < strings.length; i++) { sql += strings[i]; if (i < values.length) sql += "?"; }
    return __wf({ kind: "db.sql", sql: sql, params: values }).then(function(res){ return res.value; });
  },
};
globalThis.__runWorkflow = async function() {
  var def = globalThis.__artifact && (globalThis.__artifact.default || globalThis.__artifact);
  if (!def || typeof def.run !== "function") {
    return { status: "failed", retryable: false, message: "workflow bundle did not produce a run() function" };
  }
  try {
    var output = await def.run(step, { db: __db, input: __wfInput });
    return { status: "completed", output: output === undefined ? null : output };
  } catch (e) {
    if (e && e.__wfSuspend) return { status: "suspended", marker: e.__wfSuspend };
    // A typed control error from the author: RetryableError / FatalError carry a
    // discriminator the runtime reads. Anything else is fatal.
    var retryable = !!(e && (e.retryable === true || e.name === "RetryableError" || (e.constructor && e.constructor.name === "RetryableError")));
    var retryAfter = e && typeof e.retryAfter === "number" ? e.retryAfter : undefined;
    var message = e && e.message ? String(e.message) : String(e);
    return { status: "failed", retryable: retryable, message: message, retryAfter: retryAfter };
  }
};
`;

// Wrap the CJS bundle so `require` resolves the platform module shims and the
// def lands on `globalThis.__artifact`. Mirrors the tool sandbox's wrapper.
const workflowPrelude = `
var __executorApp = {
  connection: function(integration, opts) { return { __decl: 'single', integration: integration, description: opts && opts.description }; },
  connections: function(integration, opts) { return { __decl: 'array', integration: integration, description: opts && opts.description }; },
  catalog: function() { return { __decl: 'catalog' }; },
  defineTool: function(def) { return def; },
  defineWorkflow: function(def) { globalThis.__artifact = def; return def; },
};
var __executorUi = { config: function(){}, useQuery: function(){ return {}; }, useTool: function(){ return {}; } };
function __require(id) {
  if (id === 'executor:app') return __executorApp;
  if (id === 'executor:ui') return __executorUi;
  if (id === 'executor:ui/components') return {};
  throw new Error('module not available in sandbox: ' + id);
}
`;

const wrapBundle = (bundle: string): string => `
var module = { exports: {} };
var exports = module.exports;
var require = __require;
(function(module, exports, require){
${bundle}
})(module, exports, require);
`;

const buildWorkflowCode = (bundle: string, input: unknown): string =>
  workflowPrelude + wrapBundle(bundle) + workflowShim(input) + "\nreturn await __runWorkflow();";

export interface QuickjsWorkflowDriverDeps {
  readonly artifactStore: ArtifactStore;
  readonly timeoutMs?: number;
}

export const makeQuickjsWorkflowDriver = (deps: QuickjsWorkflowDriverDeps): WorkflowDriver => {
  const executor = makeQuickJsExecutor({ timeoutMs: deps.timeoutMs ?? WORKFLOW_TIMEOUT_MS });

  // Re-bundle the workflow entry from the pinned snapshot on each drive; the
  // runner never caches source that could drift. A published snapshot is
  // immutable, so a per-(snapshot,entry) cache would be safe, but the source of
  // truth is always the committed snapshot.
  const loadBundle = (
    scope: string,
    snapshotId: string,
    entryPath: string,
  ): Effect.Effect<string, WorkflowError> =>
    Effect.gen(function* () {
      const scopeStore = yield* deps.artifactStore
        .forScope(scope)
        .pipe(Effect.mapError((c) => new WorkflowError({ message: c.message, cause: c })));
      const files = yield* scopeStore
        .read(snapshotId as SnapshotId)
        .pipe(Effect.mapError((c) => new WorkflowError({ message: c.message, cause: c })));
      const bundle = yield* bundleEntry({ files, entry: entryPath }).pipe(
        Effect.mapError((c) => new WorkflowError({ message: c.message, cause: c })),
      );
      return bundle.code;
    });

  return {
    drive: (input, bridge: WorkflowBridge) =>
      Effect.gen(function* () {
        const code = yield* loadBundle(input.scope, input.snapshotId, input.entryPath);

        // The invoker decodes the routed `__wf` op and forwards to the host
        // bridge. Everything crossing is JSON (the cloud version is RPC).
        const invoker: SandboxToolInvoker = {
          invoke: (call: { path: string; args: unknown }) => {
            if (call.path !== "__wf") {
              return Effect.fail(
                new WorkflowError({
                  message: `unexpected workflow sandbox call: ${call.path}`,
                }),
              ) as never;
            }
            return bridge.call(call.args as never) as never;
          },
        };

        const result = yield* executor
          .execute(buildWorkflowCode(code, input.input), invoker)
          .pipe(
            Effect.mapError(
              (cause) => new WorkflowError({ message: "workflow drive failed", cause }),
            ),
          );

        if (result.error) {
          // A sandbox-level error (timeout, syntax) is fatal for the run.
          return {
            status: "failed",
            retryable: false,
            message: result.error,
          } satisfies DriveOutcome;
        }
        return result.result as DriveOutcome;
      }),
  };
};

export { isSuspend };
