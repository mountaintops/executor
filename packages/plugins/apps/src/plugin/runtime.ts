import { Effect } from "effect";

import type { ArtifactStore } from "../seams/artifact-store";
import type { ScopeDb } from "../seams/scope-db";
import type { ToolSandbox } from "../seams/tool-sandbox";
import type { LiveChannel } from "../seams/live-channel";
import type { DurableSteps, WorkflowRunner, RunView, StepView } from "../seams/workflow-runner";
import {
  publish as runPublish,
  loadDescriptorFromSnapshot,
  publishProjections,
  restageBlobs,
  type PublishOutput,
} from "../pipeline/publish";
import { PublishError } from "../pipeline/discover";
import type { AppDescriptor, ToolDescriptor, WorkflowDescriptor } from "../pipeline/descriptor";
import { bundleEntry } from "../pipeline/bundle";
import {
  buildBridge,
  rootsFor,
  type Bindings,
  type ClientResolver,
  BindingError,
} from "./bindings";
import type { AppsStore } from "./store";

// ---------------------------------------------------------------------------
// AppsRuntime — the substrate-neutral core of the apps subsystem. It owns the
// five seams + the store, and exposes the operations every surface (HTTP, MCP,
// the plugin) drives: publish, resolveTools (descriptor projection), invokeTool
// (bundle -> sandbox invoke with bound clients), and the workflow lifecycle
// (start/signal/status/history) with real journal replay + scheduling.
//
// Nothing here knows about HTTP or MCP; those are thin adapters over this.
// ---------------------------------------------------------------------------

export interface AppsRuntimeDeps {
  readonly artifactStore: ArtifactStore;
  readonly scopeDb: ScopeDb;
  readonly sandbox: ToolSandbox;
  readonly workflows: WorkflowRunner;
  readonly liveChannel: LiveChannel;
  readonly store: AppsStore;
  /** Routes a bound integration method call to the real API (policy/audit). */
  readonly resolver: ClientResolver;
}

export interface AppsRuntime {
  readonly publish: (input: {
    readonly scope: string;
    readonly files: ReadonlyMap<string, string>;
    readonly message?: string;
  }) => Effect.Effect<PublishOutput, PublishError>;
  readonly getDescriptor: (scope: string) => Effect.Effect<AppDescriptor | null>;
  /** Re-derive the projections (published-descriptor pointer + ui/skill blobs)
   *  for a scope from its latest committed snapshot. Idempotent; the recovery
   *  path when a projection write failed after the commit. */
  readonly repair: (scope: string) => Effect.Effect<AppDescriptor | null, PublishError>;
  readonly invokeTool: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly args: unknown;
    readonly bindings: Bindings;
  }) => Effect.Effect<unknown, PublishError | BindingError>;
  readonly startWorkflow: (input: {
    readonly scope: string;
    readonly workflow: string;
    readonly input?: unknown;
    readonly bindings?: Bindings;
    readonly runId?: string;
  }) => Effect.Effect<RunView, PublishError | BindingError>;
  readonly signalWorkflow: (input: {
    readonly scope: string;
    readonly runId: string;
    readonly event: string;
    readonly payload: unknown;
  }) => Effect.Effect<RunView, PublishError | BindingError>;
  readonly getRun: (runId: string) => Effect.Effect<RunView | null>;
  readonly listRuns: (scope: string) => Effect.Effect<readonly RunView[]>;
  readonly listSteps: (runId: string) => Effect.Effect<readonly StepView[]>;
  /** Serve a ui bundle by name (raw endpoint / MCP resource). */
  readonly getUiBundle: (
    scope: string,
    name: string,
  ) => Effect.Effect<{ code: string; title?: string; maxHeight?: number } | null>;
  /** Subscribe to a scope's live invalidations (SSE adapter drives this). */
  readonly subscribeLive: (
    scope: string,
    listener: (event: { table: string; version: number }) => void,
  ) => () => void;
  readonly deps: AppsRuntimeDeps;
}

const failNoDescriptor = (scope: string): PublishError =>
  new PublishError({
    message: `scope "${scope}" has no published app`,
    stage: "project",
    diagnostics: [],
  });

export const makeAppsRuntime = (deps: AppsRuntimeDeps): AppsRuntime => {
  // Bundle cache keyed by (snapshot, sourcePath): a published snapshot is
  // immutable, so its bundles never change.
  const bundleCache = new Map<string, string>();

  const bundleFor = (
    descriptor: AppDescriptor,
    sourcePath: string,
  ): Effect.Effect<string, PublishError> =>
    Effect.gen(function* () {
      const cacheKey = `${descriptor.snapshotId}:${sourcePath}`;
      const cached = bundleCache.get(cacheKey);
      if (cached) return cached;
      const scopeStore = yield* deps.artifactStore
        .forScope(descriptor.scope)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const files = yield* scopeStore
        .read(descriptor.snapshotId as never)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const bundle = yield* bundleEntry({ files, entry: sourcePath }).pipe(
        Effect.mapError(
          (c) =>
            new PublishError({
              message: c.message,
              stage: "bundle",
              diagnostics: [{ path: sourcePath, message: c.message }],
            }),
        ),
      );
      bundleCache.set(cacheKey, bundle.code);
      return bundle.code;
    });

  const requireDescriptor = (scope: string): Effect.Effect<AppDescriptor, PublishError> =>
    deps.store.getDescriptor(scope).pipe(
      Effect.mapError(
        (c) => new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
      ),
      Effect.flatMap((d) =>
        d ? Effect.succeed(d) : recoverFromSnapshot(scope).pipe(Effect.orElseSucceed(() => null)),
      ),
      Effect.flatMap((d) => (d ? Effect.succeed(d) : Effect.fail(failNoDescriptor(scope)))),
    );

  // A content-addressed blob write, mapped into the pipeline's PublishError.
  const putBlobAsProjection = (hash: string, value: string): Effect.Effect<void, PublishError> =>
    deps.store
      .putBlob(hash, value)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
        ),
      );

  // The published-descriptor pointer projection.
  const putDescriptorPointer = (descriptor: AppDescriptor): Effect.Effect<void, PublishError> =>
    deps.store
      .putDescriptor("org", descriptor)
      .pipe(
        Effect.mapError(
          (c) => new PublishError({ message: String(c), stage: "project", diagnostics: [] }),
        ),
      );

  // Load the latest committed snapshot's descriptor for a scope (recompute-on-
  // read source of truth), or null if the scope has never published.
  const recoverFromSnapshot = (scope: string): Effect.Effect<AppDescriptor | null, PublishError> =>
    Effect.gen(function* () {
      const scopeStore = yield* deps.artifactStore
        .forScope(scope)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const latest = yield* scopeStore
        .latest()
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      if (!latest) return null;
      return yield* loadDescriptorFromSnapshot(deps.artifactStore, scope, latest.id);
    });

  // Idempotently re-derive every projection (blobs + pointer) for a scope from
  // its latest committed snapshot. The self-healing recovery path.
  const repairScope = (scope: string): Effect.Effect<AppDescriptor | null, PublishError> =>
    Effect.gen(function* () {
      const descriptor = yield* recoverFromSnapshot(scope);
      if (!descriptor) return null;
      const blobs = yield* restageBlobs({ artifactStore: deps.artifactStore }, descriptor);
      yield* publishProjections({ putBlob: putBlobAsProjection }, descriptor, blobs);
      yield* putDescriptorPointer(descriptor);
      return descriptor;
    });

  const invokeToolInternal = (
    scope: string,
    descriptor: AppDescriptor,
    toolDesc: ToolDescriptor,
    args: unknown,
    bindings: Bindings,
  ): Effect.Effect<unknown, PublishError | BindingError> =>
    Effect.gen(function* () {
      const roots = yield* rootsFor(toolDesc.connections, bindings);
      const code = yield* bundleFor(descriptor, toolDesc.sourcePath);
      const db = yield* deps.scopeDb
        .forScope(scope)
        .pipe(
          Effect.mapError(
            (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
          ),
        );
      const bridge = buildBridge({
        declared: toolDesc.connections,
        bindings,
        db,
        resolver: deps.resolver,
      });
      const result = yield* deps.sandbox
        .invoke(code, { artifact: toolDesc.name, kind: "tool", input: args, roots }, bridge)
        .pipe(
          Effect.mapError(
            (c) =>
              new PublishError({
                message: c.message,
                stage: "project",
                diagnostics: [{ path: toolDesc.sourcePath, message: c.message }],
              }),
          ),
        );
      return result.output;
    });

  // Build the workflow body closure for one run: replay the workflow's compiled
  // bundle over the DurableSteps. Our sandbox runs a tool handler, not a
  // long-lived stepful body, so we drive the workflow with a thin interpreter:
  // the workflow's `run(step, {db})` is executed in-process against the
  // DurableSteps facade, with `step.tool` -> the runner bindings and
  // `db.sql` -> the scope db. This keeps CF semantics while the durable journal
  // lives in the WorkflowRunner seam.
  const workflowBody = (
    scope: string,
    descriptor: AppDescriptor,
    wfDesc: WorkflowDescriptor,
  ): ((steps: DurableSteps) => Promise<unknown>) => {
    return async (steps: DurableSteps) => {
      const code = await Effect.runPromise(
        bundleFor(descriptor, wfDesc.sourcePath).pipe(Effect.orDie),
      );
      const db = await Effect.runPromise(deps.scopeDb.forScope(scope).pipe(Effect.orDie));
      // Interpret the workflow: run its bundle in the sandbox is not how durable
      // steps work (the body must call back into our journaled `steps`). Instead
      // we evaluate the workflow module here and invoke its `run(step, {db})`.
      // The compiled bundle sets globalThis.__artifact = the workflow def.
      const def = extractWorkflowDef(code);
      const scopeDbClient = {
        sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
          Effect.runPromise(db.sql(strings, ...values).pipe(Effect.orDie)),
      };
      return def.run(steps, { db: scopeDbClient });
    };
  };

  const bindingsForRunTool = (
    scope: string,
    descriptor: AppDescriptor,
    recordedBindings: Bindings,
  ) => ({
    runTool: async (address: string, toolArgs: unknown) => {
      const toolDesc = descriptor.tools.find((t) => t.name === address);
      if (!toolDesc) throw new Error(`workflow step.tool: unknown tool "${address}"`);
      // Bind the called tool's declared connections: use the run's recorded
      // bindings where present, else default each role to a same-named
      // connection (self-host single-tenant convention).
      const toolBindings: Record<string, Bindings[string]> = { ...recordedBindings };
      for (const [role, decl] of Object.entries(toolDesc.connections)) {
        if (toolBindings[role]) continue;
        if (decl.kind === "array") {
          toolBindings[role] = { kind: "array", connections: [decl.integration] };
        } else if (decl.kind !== "catalog") {
          toolBindings[role] = { kind: "single", connection: decl.integration };
        }
      }
      return Effect.runPromise(
        invokeToolInternal(scope, descriptor, toolDesc, toolArgs, toolBindings).pipe(Effect.orDie),
      );
    },
    notify: async (_msg: { title: string; body?: string; link?: string }) => {
      // Self-host delivery sink: recorded as a journaled step; a real host wires
      // this to notifications. No-op body here keeps the workflow durable.
    },
  });

  return {
    deps,
    publish: (input) =>
      Effect.gen(function* () {
        // publish commits the snapshot LAST and writes the ui/skill blobs as
        // post-commit projections. Then we write the published-descriptor
        // pointer, the final projection. If this pointer write fails, the app is
        // still recoverable from the committed snapshot via `repair` /
        // recompute-on-read (the descriptor lives in `.executor/descriptor.json`
        // inside the commit).
        const out = yield* runPublish(
          {
            artifactStore: deps.artifactStore,
            sandbox: deps.sandbox,
            putBlob: putBlobAsProjection,
          },
          { scope: input.scope, files: input.files, commitMessage: input.message },
        );
        yield* putDescriptorPointer(out.descriptor);
        return out;
      }),

    // Recompute-on-read: prefer the pointer, but if it is missing yet the scope
    // has a committed snapshot carrying a descriptor, recover from the snapshot
    // (and lazily repair the pointer) so a projection failure is self-healing.
    getDescriptor: (scope) =>
      deps.store.getDescriptor(scope).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((pointer) =>
          pointer
            ? Effect.succeed(pointer)
            : recoverFromSnapshot(scope).pipe(Effect.orElseSucceed(() => null)),
        ),
      ),

    repair: (scope) => repairScope(scope),

    invokeTool: (input) =>
      Effect.gen(function* () {
        const descriptor = yield* requireDescriptor(input.scope);
        const toolDesc = descriptor.tools.find((t) => t.name === input.tool);
        if (!toolDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `tool "${input.tool}" is not published in scope "${input.scope}"`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        return yield* invokeToolInternal(
          input.scope,
          descriptor,
          toolDesc,
          input.args,
          input.bindings,
        );
      }),

    startWorkflow: (input) =>
      Effect.gen(function* () {
        const descriptor = yield* requireDescriptor(input.scope);
        const wfDesc = descriptor.workflows.find((w) => w.name === input.workflow);
        if (!wfDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `workflow "${input.workflow}" is not published in scope "${input.scope}"`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const bindings = input.bindings ?? {};
        const body = workflowBody(input.scope, descriptor, wfDesc);
        return yield* deps.workflows
          .start(
            {
              scope: input.scope,
              workflow: input.workflow,
              snapshotId: descriptor.snapshotId,
              input: input.input ?? {},
              runId: input.runId,
            },
            body,
            bindingsForRunTool(input.scope, descriptor, bindings),
          )
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
      }),

    signalWorkflow: (input) =>
      Effect.gen(function* () {
        const run = yield* deps.workflows
          .get(input.runId)
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
        if (!run) {
          return yield* Effect.fail(
            new PublishError({
              message: `no run ${input.runId}`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const descriptor = yield* requireDescriptor(run.scope);
        const wfDesc = descriptor.workflows.find((w) => w.name === run.workflow);
        if (!wfDesc) {
          return yield* Effect.fail(
            new PublishError({
              message: `workflow ${run.workflow} gone`,
              stage: "project",
              diagnostics: [],
            }),
          );
        }
        const body = workflowBody(run.scope, descriptor, wfDesc);
        return yield* deps.workflows
          .signal(
            input.runId,
            input.event,
            input.payload,
            body,
            bindingsForRunTool(run.scope, descriptor, {}),
          )
          .pipe(
            Effect.mapError(
              (c) => new PublishError({ message: c.message, stage: "project", diagnostics: [] }),
            ),
          );
      }),

    getRun: (runId) => deps.workflows.get(runId).pipe(Effect.orElseSucceed(() => null)),
    listRuns: (scope) =>
      deps.workflows.list({ scope }).pipe(Effect.orElseSucceed(() => [] as readonly RunView[])),
    listSteps: (runId) =>
      deps.workflows.listSteps(runId).pipe(Effect.orElseSucceed(() => [] as readonly StepView[])),

    getUiBundle: (scope, name) =>
      Effect.gen(function* () {
        const descriptor = yield* deps.store
          .getDescriptor(scope)
          .pipe(Effect.orElseSucceed(() => null));
        if (!descriptor) return null;
        const uiDesc = descriptor.ui.find((u) => u.name === name);
        if (!uiDesc) return null;
        const code = yield* deps.store
          .getBlob(`ui/${uiDesc.bundleHash}`)
          .pipe(Effect.orElseSucceed(() => null));
        if (!code) return null;
        return { code, title: uiDesc.title, maxHeight: uiDesc.maxHeight };
      }),

    subscribeLive: (scope, listener) =>
      deps.liveChannel.subscribe(scope, (event) =>
        listener({ table: event.table, version: event.version }),
      ),
  };
};

// Extract the workflow def from a compiled bundle by running it in a tiny
// module shim (Node-side, trusted: this is our own runtime, not user isolation
// for the durable interpreter — the tool HANDLERS still run in the sandbox).
// The bundle set globalThis.__artifact to the workflow def object.
const extractWorkflowDef = (
  code: string,
): { run: (steps: DurableSteps, deps: { db: unknown }) => Promise<unknown> } => {
  const g: Record<string, unknown> = {};
  const shim = {
    connection: (integration: string, opts?: { description?: string }) => ({
      __decl: "single",
      integration,
      description: opts?.description,
    }),
    connections: (integration: string) => ({ __decl: "array", integration }),
    catalog: () => ({ __decl: "catalog" }),
    defineTool: (def: unknown) => {
      g.__artifact = def;
      return def;
    },
    defineWorkflow: (def: unknown) => {
      g.__artifact = def;
      return def;
    },
  };
  const req = (id: string) => {
    if (id === "executor:app") return shim;
    if (id === "executor:ui") return {};
    if (id === "executor:ui/components") return {};
    throw new Error(`module not available: ${id}`);
  };
  const moduleObj = { exports: {} as Record<string, unknown> };
  const globalThisShim = g as unknown as typeof globalThis;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function("module", "exports", "require", "globalThis", code);
  factory(moduleObj, moduleObj.exports, req, globalThisShim);
  const def = (g.__artifact ?? moduleObj.exports.default ?? moduleObj.exports) as {
    run: (steps: DurableSteps, deps: { db: unknown }) => Promise<unknown>;
  };
  if (!def || typeof def.run !== "function") {
    throw new Error("workflow bundle did not produce a run() function");
  }
  return def;
};
