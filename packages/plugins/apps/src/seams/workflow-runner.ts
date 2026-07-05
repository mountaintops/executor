import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// WorkflowRunner — durable workflow execution with an event-sourced journal.
//
// Cloudflare Workflows semantics verbatim: `step.do(name, fn)` memoized by the
// journal, `step.sleep`, `step.waitForEvent`, plus executor's `step.tool`
// (journal + audit in one). Kill mid-step -> restart -> completed steps do NOT
// re-execute (replay reads the journal). The self-hosted backing is a SQLite
// journal replay runner + in-process scheduler; the cloud backing (future) is
// CF Workflows + dynamic-workflows. The journal shape is modeled on
// vercel/workflow's World Storage contract (append-only events, materialized
// run/step views).
//
// SUBSTRATE-NEUTRALITY (Fix 3): the runner is driven by DATA, not closures. The
// author's workflow body runs INSIDE the ToolSandbox (QuickJS), the same
// isolation the tool handlers use, and every `step.*` / `db.sql` call crosses a
// serializable `WorkflowBridge` the host services against the journal. So
// `start`/`resume`/`signal` take (scope, workflow, snapshotId, entryPath,
// input) — never an `execute(steps)` closure — and the whole seam can back onto
// an RPC (CF Workflows) unchanged. A `WorkflowDriver` (see below) is the one
// injected collaborator: it loads the pinned bundle and runs one replay in the
// sandbox behind the bridge.
// ---------------------------------------------------------------------------

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type RunStatus = "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export interface RunView {
  readonly runId: string;
  readonly scope: string;
  readonly workflow: string;
  readonly snapshotId: string;
  readonly status: RunStatus;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type StepStatus = "completed" | "failed";

export interface StepView {
  readonly runId: string;
  readonly name: string;
  readonly status: StepStatus;
  readonly output?: unknown;
  readonly error?: string;
  readonly attempt: number;
  readonly completedAt: number;
}

// ---------------------------------------------------------------------------
// The serializable step bridge. This is the ONE channel between the sandboxed
// workflow body and the host journal. Every op and its result is JSON (the
// cloud backing is an RPC), so the seam forbids passing closures or live
// objects. The host (the SQLite backing) services each op against the journal:
// a completed step returns its recorded value WITHOUT re-executing; a new step
// records and returns; sleep/waitForEvent return a structured suspend.
// ---------------------------------------------------------------------------

/** One op the sandboxed body asks the host to service. `kind` discriminates. */
export type WorkflowBridgeOp =
  // `step.do`: the host reports whether the step is journaled. When NOT
  // journaled the sandbox runs the author `fn` locally and reports its value via
  // `step.record`. (The fn body cannot cross the boundary, so it stays in the
  // sandbox; only the value it produced is recorded host-side.)
  | { readonly kind: "step.check"; readonly step: string }
  | { readonly kind: "step.record"; readonly step: string; readonly value: unknown }
  // `step.tool`: journaled? return value : run the bound tool (journal + audit),
  // record, return.
  | {
      readonly kind: "step.tool";
      readonly step: string;
      readonly address: string;
      readonly args: unknown;
    }
  // `step.sleep`: schedule + suspend the first time; complete when due.
  | { readonly kind: "step.sleep"; readonly step: string; readonly ms: number }
  // `step.waitForEvent`: return the delivered payload or suspend awaiting it.
  | { readonly kind: "step.waitForEvent"; readonly step: string }
  // `step.notify`: a memoized best-effort side channel.
  | { readonly kind: "step.notify"; readonly msg: { title: string; body?: string; link?: string } }
  // `db.sql`: a scope-db statement between steps (parameterized).
  | { readonly kind: "db.sql"; readonly sql: string; readonly params: readonly unknown[] };

/** A structured suspension marker (never a string-matched error). The runner
 *  reads `kind` to set the run's sleeping/waiting state. */
export type SuspendMarker =
  | { readonly suspend: "sleep" }
  | { readonly suspend: "event"; readonly event: string };

/** A step-level error the host reports back to the sandbox body (e.g. a
 *  `step.tool` whose bound tool threw). `retryable` is a typed discriminator so
 *  the body / runner never string-match: a retryable step error leaves the run
 *  re-drivable, a fatal one fails it. */
export interface StepErrorMarker {
  readonly error: {
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfter?: number;
  };
}

/** The result the host bridge returns for one op: a plain value, a structured
 *  suspend, or a structured step error (all JSON, no thrown control flow). */
export type WorkflowBridgeResult = { readonly value: unknown } | SuspendMarker | StepErrorMarker;

/** The serializable bridge the sandboxed body calls out through. */
export interface WorkflowBridge {
  readonly call: (op: WorkflowBridgeOp) => Effect.Effect<WorkflowBridgeResult, WorkflowError>;
}

/** The typed outcome of ONE sandboxed replay of a workflow body. Structured, so
 *  the runner never string-matches: a `suspended` outcome carries the marker; a
 *  `failed` outcome carries a typed retryable-vs-fatal discriminator. */
export type DriveOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | { readonly status: "suspended"; readonly marker: SuspendMarker }
  | {
      readonly status: "failed";
      readonly retryable: boolean;
      readonly message: string;
      readonly retryAfter?: number;
    };

/** How `step.tool` and `step.notify` reach the outside world for a run: bound to
 *  the run's snapshot + scope + the real tool-invoke/audit path. Everything they
 *  take/return is JSON. The host calls them only for a step NOT yet journaled,
 *  so they run at most once per step across replays. */
export interface WorkflowBindings {
  readonly runTool: (address: string, args: unknown) => Promise<unknown>;
  readonly notify: (msg: {
    readonly title: string;
    readonly body?: string;
    readonly link?: string;
  }) => Promise<void>;
  /** Run a parameterized scope-db statement for a `db.sql` op in the body.
   *  Returns the result rows as JSON. Optional: a runner may omit db access. */
  readonly runDb?: (scope: string, sql: string, params: readonly unknown[]) => Promise<unknown>;
}

/**
 * The DATA-driven driver the runner uses to execute one replay. It loads the
 * pinned workflow bundle (from the snapshot) and runs it inside the ToolSandbox
 * behind the `WorkflowBridge`, returning a structured `DriveOutcome`. This is
 * the seam that keeps the orchestrator substrate-neutral: it takes the run's
 * identity + input + a JSON bridge, never a closure over host objects.
 */
export interface WorkflowDriver {
  readonly drive: (
    input: {
      readonly scope: string;
      readonly workflow: string;
      readonly snapshotId: string;
      readonly entryPath: string;
      readonly input: unknown;
    },
    bridge: WorkflowBridge,
  ) => Effect.Effect<DriveOutcome, WorkflowError>;
}

export interface StartRunInput {
  readonly scope: string;
  readonly workflow: string;
  readonly snapshotId: string;
  /** The workflow entry path within the snapshot, e.g. `workflows/morning-sync.ts`. */
  readonly entryPath: string;
  readonly input: unknown;
  /** Optional caller-supplied run id (idempotent starts / scheduler dedupe). */
  readonly runId?: string;
}

/**
 * The durable runner. `start` creates a run and drives it (in the sandbox) to
 * its first suspension or completion. `resume` re-drives a suspended/interrupted
 * run from the journal (this is what makes the kill test pass: completed steps
 * replay from the journal and never re-execute). `signal` delivers a
 * waitForEvent payload. `get`/`listSteps` are the queryable status/history.
 *
 * All of these take DATA — the workflow identity is enough, the runner loads the
 * bundle and runs it via the injected `WorkflowDriver`. `bindings` is how
 * `step.tool` / `step.notify` reach the real invoke path for THIS run.
 */
export interface WorkflowRunner {
  readonly start: (
    input: StartRunInput,
    bindings: WorkflowBindings,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly resume: (
    runId: string,
    bindings: WorkflowBindings,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly signal: (
    runId: string,
    eventName: string,
    payload: unknown,
    bindings: WorkflowBindings,
  ) => Effect.Effect<RunView, WorkflowError>;
  readonly cancel: (runId: string) => Effect.Effect<RunView, WorkflowError>;
  readonly get: (runId: string) => Effect.Effect<RunView | null, WorkflowError>;
  readonly list: (filter?: {
    readonly scope?: string;
    readonly workflow?: string;
  }) => Effect.Effect<readonly RunView[], WorkflowError>;
  readonly listSteps: (runId: string) => Effect.Effect<readonly StepView[], WorkflowError>;
  readonly close: () => Effect.Effect<void, WorkflowError>;
}

/** Control errors that steer retry/replay, matching CF's vocabulary. Surfaced
 *  from the sandboxed body via the typed `DriveOutcome.retryable` discriminator,
 *  never by string-matching an error message. */
export class FatalError extends Data.TaggedError("FatalError")<{
  readonly message: string;
}> {}

export class RetryableError extends Data.TaggedError("RetryableError")<{
  readonly message: string;
  readonly retryAfter?: number;
}> {}
