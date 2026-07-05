import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect } from "effect";

import {
  WorkflowError,
  type RunView,
  type StartRunInput,
  type StepView,
  type SuspendMarker,
  type WorkflowBindings,
  type WorkflowBridge,
  type WorkflowBridgeOp,
  type WorkflowBridgeResult,
  type WorkflowDriver,
  type WorkflowRunner,
} from "../seams/workflow-runner";

// ---------------------------------------------------------------------------
// SQLite journal replay WorkflowRunner (self-hosted).
//
// An append-only event journal in SQLite backs materialized run/step views
// (modeled on vercel/workflow's World Storage contract). The author's workflow
// body runs INSIDE the ToolSandbox (via the injected `WorkflowDriver`), NOT
// in-process; each `step.*` / `db.sql` call crosses the serializable
// `WorkflowBridge` this runner implements and is serviced against the journal:
//   - a completed step replays its recorded result WITHOUT re-executing
//   - the first not-yet-recorded step actually executes, appends its result
//   - `sleep`/`waitForEvent` return a STRUCTURED suspend marker; the driver
//     unwinds the body and the runner marks the run sleeping/waiting; `resume`/
//     `signal` re-drive it later
//
// This is what makes the kill test pass: SIGKILL mid-step -> restart over the
// same DB file -> `resume` replays completed steps from the journal and only
// the interrupted (never-recorded) step runs again. A side-effect from a
// COMPLETED step happens exactly once.
//
// `start`/`resume`/`signal` take DATA (scope/workflow/snapshot/entryPath/input),
// never a closure — the run row persists the identity so `resume` re-drives it
// with no host state. `step.tool` / `step.notify` reach the outside world
// through the caller-supplied `WorkflowBindings`.
// ---------------------------------------------------------------------------

const nowMs = () => Date.now();

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wf_run (
  run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, workflow TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, entry_path TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL,
  output TEXT, error TEXT, wake_at INTEGER, wait_event TEXT, bindings TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wf_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, step_name TEXT, data TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wf_event_run ON wf_event (run_id, seq);
CREATE TABLE IF NOT EXISTS wf_step (
  run_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  output TEXT, error TEXT, attempt INTEGER NOT NULL DEFAULT 1, completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);
CREATE TABLE IF NOT EXISTS wf_signal (
  run_id TEXT NOT NULL, event_name TEXT NOT NULL, payload TEXT,
  PRIMARY KEY (run_id, event_name)
);
CREATE TABLE IF NOT EXISTS wf_lease (
  run_id TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`;

/** How long a drive lease is held before it is considered abandoned (a driver
 *  that crashed mid-step). A live driver renews implicitly by finishing and
 *  releasing; a genuinely long step just extends past this and a concurrent
 *  driver treats the lease as stale, which is acceptable because the journal
 *  still guarantees a COMPLETED step never re-runs — the lease only prevents the
 *  narrow unjournaled-step double-execution window. */
const LEASE_MS = 30_000;

interface StepRecord {
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
  attempt: number;
}

interface RunRow extends RunView {
  readonly entryPath: string;
  readonly persistedBindings?: unknown;
}

export interface SqliteWorkflowRunnerOptions {
  /** Journal DB path, or ":memory:". A file path is what the kill test needs. */
  readonly path: string;
  /** The DATA-driven driver that runs one replay of a workflow body inside the
   *  sandbox behind the bridge. */
  readonly driver: WorkflowDriver;
  /** Injected clock for deterministic sleep in tests. */
  readonly clock?: () => number;
}

export const makeSqliteWorkflowRunner = (options: SqliteWorkflowRunnerOptions): WorkflowRunner => {
  if (options.path !== ":memory:") mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const client: Client = createClient({ url: toUrl(options.path) });
  const clock = options.clock ?? nowMs;
  const driver = options.driver;
  let ready: Promise<void> | undefined;

  const init = async () => {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA.split(";")) {
          const s = stmt.trim();
          if (s) await client.execute(s);
        }
        // Idempotent add for DBs created before the `bindings` column existed
        // (a persisted journal file from an earlier version). SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, so tolerate the duplicate-column error.
        await client.execute("ALTER TABLE wf_run ADD COLUMN bindings TEXT").catch(() => undefined);
      })();
    }
    return ready;
  };

  const loadRun = async (runId: string): Promise<RunRow | null> => {
    await init();
    const res = await client.execute({
      sql: "SELECT * FROM wf_run WHERE run_id = ?",
      args: [runId],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      runId: String(row.run_id),
      scope: String(row.scope),
      workflow: String(row.workflow),
      snapshotId: String(row.snapshot_id),
      entryPath: String(row.entry_path),
      status: String(row.status) as RunView["status"],
      input: JSON.parse(String(row.input)),
      output: row.output != null ? JSON.parse(String(row.output)) : undefined,
      error: row.error != null ? String(row.error) : undefined,
      persistedBindings: row.bindings != null ? JSON.parse(String(row.bindings)) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  };

  const loadSteps = async (runId: string): Promise<Map<string, StepRecord>> => {
    const res = await client.execute({
      sql: "SELECT name, status, output, error, attempt FROM wf_step WHERE run_id = ?",
      args: [runId],
    });
    const map = new Map<string, StepRecord>();
    for (const r of res.rows) {
      map.set(String(r.name), {
        status: String(r.status) as StepRecord["status"],
        output: r.output != null ? JSON.parse(String(r.output)) : undefined,
        error: r.error != null ? String(r.error) : undefined,
        attempt: Number(r.attempt),
      });
    }
    return map;
  };

  const nextSeq = async (runId: string): Promise<number> => {
    const res = await client.execute({
      sql: "SELECT COALESCE(MAX(seq), 0) AS m FROM wf_event WHERE run_id = ?",
      args: [runId],
    });
    return Number(res.rows[0]?.m ?? 0) + 1;
  };

  const appendEvent = async (
    runId: string,
    type: string,
    stepName: string | null,
    data: unknown,
  ): Promise<void> => {
    const seq = await nextSeq(runId);
    await client.execute({
      sql: "INSERT INTO wf_event (run_id, seq, type, step_name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [runId, seq, type, stepName, data === undefined ? null : JSON.stringify(data), clock()],
    });
  };

  const recordStep = async (runId: string, name: string, record: StepRecord): Promise<void> => {
    await client.execute({
      sql: `INSERT INTO wf_step (run_id, name, status, output, error, attempt, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, name) DO UPDATE SET status=excluded.status, output=excluded.output,
              error=excluded.error, attempt=excluded.attempt, completed_at=excluded.completed_at`,
      args: [
        runId,
        name,
        record.status,
        record.output === undefined ? null : JSON.stringify(record.output),
        record.error ?? null,
        record.attempt,
        clock(),
      ],
    });
    await appendEvent(runId, `step_${record.status}`, name, record.output ?? record.error);
  };

  const setRunStatus = async (
    runId: string,
    status: RunView["status"],
    extra: { output?: unknown; error?: string; wakeAt?: number; waitEvent?: string } = {},
  ): Promise<void> => {
    await client.execute({
      sql: "UPDATE wf_run SET status = ?, output = ?, error = ?, wake_at = ?, wait_event = ?, updated_at = ? WHERE run_id = ?",
      args: [
        status,
        extra.output === undefined ? null : JSON.stringify(extra.output),
        extra.error ?? null,
        extra.wakeAt ?? null,
        extra.waitEvent ?? null,
        clock(),
        runId,
      ],
    });
    await appendEvent(runId, `run_${status}`, null, extra.output ?? extra.error);
  };

  // ---------------------------------------------------------------------------
  // The host-side WorkflowBridge: services each op the sandboxed body sends
  // against the journal for ONE run. The journal is loaded once per drive and
  // held in `journaled` so replays are consistent and O(1). Only ops for a step
  // NOT yet journaled cause a side effect (a tool call, a record); everything
  // else replays from the journal.
  // ---------------------------------------------------------------------------
  const makeBridge = (
    runId: string,
    journaled: Map<string, StepRecord>,
    bindings: WorkflowBindings,
    scope: string,
  ): WorkflowBridge => {
    const value = (v: unknown): WorkflowBridgeResult => ({ value: v });
    const suspend = (m: SuspendMarker): WorkflowBridgeResult => m;

    const service = async (op: WorkflowBridgeOp): Promise<WorkflowBridgeResult> => {
      switch (op.kind) {
        case "step.check": {
          const existing = journaled.get(op.step);
          if (existing && existing.status === "completed") {
            return value({ journaled: true, output: existing.output });
          }
          return value({ journaled: false });
        }
        case "step.record": {
          const record: StepRecord = { status: "completed", output: op.value, attempt: 1 };
          journaled.set(op.step, record);
          await recordStep(runId, op.step, record);
          return value({ ok: true });
        }
        case "step.tool": {
          const existing = journaled.get(op.step);
          if (existing && existing.status === "completed") return value(existing.output);
          try {
            const out = await bindings.runTool(op.address, op.args);
            const record: StepRecord = { status: "completed", output: out, attempt: 1 };
            journaled.set(op.step, record);
            await recordStep(runId, op.step, record);
            return value(out);
          } catch (cause) {
            // A bound-tool failure is NOT journaled (so a retry can re-run it).
            // Report it as a structured step error with a typed retryable flag.
            const retryable = !!(
              cause &&
              typeof cause === "object" &&
              ((cause as { retryable?: boolean }).retryable === true ||
                (cause as { name?: string }).name === "RetryableError")
            );
            const message = cause instanceof Error ? cause.message : String(cause);
            const retryAfter =
              cause && typeof (cause as { retryAfter?: number }).retryAfter === "number"
                ? (cause as { retryAfter: number }).retryAfter
                : undefined;
            return { error: { message, retryable, retryAfter } };
          }
        }
        case "step.sleep": {
          const existing = journaled.get(op.step);
          if (existing && existing.status === "completed") return value(null);
          const wakeAt = clock() + op.ms;
          const record: StepRecord = { status: "completed", output: { wakeAt }, attempt: 1 };
          journaled.set(op.step, record);
          await recordStep(runId, op.step, record);
          return suspend({ suspend: "sleep" });
        }
        case "step.waitForEvent": {
          const existing = journaled.get(op.step);
          if (existing && existing.status === "completed") return value(existing.output);
          const eventName = op.step.replace(/^wait:/, "");
          const sig = await client.execute({
            sql: "SELECT payload FROM wf_signal WHERE run_id = ? AND event_name = ?",
            args: [runId, eventName],
          });
          if (sig.rows[0]) {
            const payload =
              sig.rows[0].payload != null ? JSON.parse(String(sig.rows[0].payload)) : undefined;
            const record: StepRecord = { status: "completed", output: payload, attempt: 1 };
            journaled.set(op.step, record);
            await recordStep(runId, op.step, record);
            return value(payload);
          }
          return suspend({ suspend: "event", event: eventName });
        }
        case "step.notify": {
          const step = `notify:${op.msg.title}`;
          const existing = journaled.get(step);
          if (existing && existing.status === "completed") return value({ notified: true });
          await bindings.notify(op.msg);
          const record: StepRecord = {
            status: "completed",
            output: { notified: true },
            attempt: 1,
          };
          journaled.set(step, record);
          await recordStep(runId, step, record);
          return value({ notified: true });
        }
        case "db.sql": {
          // The workflow's scope-db access between steps. Not memoized (reads);
          // authors put durable side effects in step.do / step.tool.
          const out = await bindings.runDb?.(scope, op.sql, op.params);
          return value(out ?? []);
        }
      }
    };

    return {
      call: (op) =>
        Effect.tryPromise({
          try: () => service(op),
          catch: (cause) => new WorkflowError({ message: "workflow bridge op failed", cause }),
        }),
    };
  };

  // ---------------------------------------------------------------------------
  // Single-driver lease. A run may be driven concurrently (start + signal +
  // resume racing); without coordination each driver loads the same "step not
  // journaled yet" view and both execute the unjournaled `step.tool`, running
  // its side effect twice. The lease makes drive single-driver per run: a driver
  // atomically claims the run row before executing and releases after. A second
  // driver that fails to claim WAITS for the holder to finish, then re-drives —
  // by which point the step is journaled, so it replays instead of re-executing.
  //
  // The claim is a single atomic statement (INSERT .. ON CONFLICT DO UPDATE with
  // a WHERE that only overwrites an EXPIRED lease), so exactly one racer wins
  // even under SQLite's serialized writer.
  // ---------------------------------------------------------------------------
  const tryClaim = async (runId: string, holder: string): Promise<boolean> => {
    const now = clock();
    const res = await client.execute({
      sql: `INSERT INTO wf_lease (run_id, holder, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
              WHERE wf_lease.expires_at <= ?`,
      args: [runId, holder, now + LEASE_MS, now],
    });
    // `changes` is 1 when we inserted or overwrote an expired lease, 0 when the
    // ON CONFLICT WHERE filtered out (a live lease is held by someone else).
    return Number(res.rowsAffected ?? 0) > 0;
  };

  const releaseClaim = async (runId: string, holder: string): Promise<void> => {
    await client.execute({
      sql: "DELETE FROM wf_lease WHERE run_id = ? AND holder = ?",
      args: [runId, holder],
    });
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Claim, or wait for the current holder to release (or its lease to expire),
  // then claim. Returns the holder token once held.
  const acquire = async (runId: string): Promise<string> => {
    const holder = `d-${clock()}-${Math.random().toString(36).slice(2)}`;
    // Bounded spin: LEASE_MS is the worst case before a stale lease is reclaimed.
    // Poll frequently so the follow-up re-drive is prompt once the holder frees.
    for (;;) {
      if (await tryClaim(runId, holder)) return holder;
      await sleep(5);
    }
  };

  const driveExclusive = (
    run: RunRow,
    bindings: WorkflowBindings,
  ): Effect.Effect<RunView, WorkflowError> =>
    Effect.gen(function* () {
      const holder = yield* Effect.tryPromise({
        try: () => acquire(run.runId),
        catch: (cause) => new WorkflowError({ message: "lease acquire failed", cause }),
      });
      // Re-load the run + drive under the lease; a second driver that waited for
      // the lease re-reads the (now-updated) journal and replays completed steps.
      const fresh = yield* Effect.tryPromise({
        try: () => loadRun(run.runId),
        catch: (cause) => new WorkflowError({ message: "lease reload failed", cause }),
      });
      return yield* driveUnleased(fresh ?? run, bindings).pipe(
        Effect.ensuring(Effect.promise(() => releaseClaim(run.runId, holder))),
      );
    });

  const driveUnleased = (
    run: RunRow,
    bindings: WorkflowBindings,
  ): Effect.Effect<RunView, WorkflowError> =>
    Effect.gen(function* () {
      const journaled = yield* Effect.tryPromise({
        try: () => loadSteps(run.runId),
        catch: (cause) => new WorkflowError({ message: "load steps failed", cause }),
      });
      const bridge = makeBridge(run.runId, journaled, bindings, run.scope);
      const outcome = yield* driver.drive(
        {
          scope: run.scope,
          workflow: run.workflow,
          snapshotId: run.snapshotId,
          entryPath: run.entryPath,
          input: run.input,
        },
        bridge,
      );
      yield* Effect.tryPromise({
        try: async () => {
          if (outcome.status === "completed") {
            await setRunStatus(run.runId, "completed", { output: outcome.output });
          } else if (outcome.status === "suspended") {
            if (outcome.marker.suspend === "sleep") {
              await setRunStatus(run.runId, "sleeping");
            } else {
              await setRunStatus(run.runId, "waiting", { waitEvent: outcome.marker.event });
            }
          } else if (outcome.retryable) {
            // Re-drivable: leave the run running so a later resume retries.
            await setRunStatus(run.runId, "running", { error: outcome.message });
          } else {
            await setRunStatus(run.runId, "failed", { error: outcome.message });
          }
        },
        catch: (cause) => new WorkflowError({ message: "persist outcome failed", cause }),
      });
      const view = yield* Effect.tryPromise({
        try: () => loadRun(run.runId),
        catch: (cause) => new WorkflowError({ message: "reload failed", cause }),
      });
      return view!;
    });

  const resumeImpl = (
    runId: string,
    bindings: WorkflowBindings,
  ): Effect.Effect<RunView, WorkflowError> =>
    Effect.tryPromise({
      try: () => loadRun(runId),
      catch: (cause) => new WorkflowError({ message: "resume load failed", cause }),
    }).pipe(
      Effect.flatMap((run) => {
        if (!run) return Effect.fail(new WorkflowError({ message: `no run ${runId}` }));
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          return Effect.succeed(run as RunView);
        }
        return Effect.tryPromise({
          try: async () => {
            await setRunStatus(runId, "running");
            return (await loadRun(runId))!;
          },
          catch: (cause) => new WorkflowError({ message: "resume set-running failed", cause }),
        }).pipe(Effect.flatMap((fresh) => driveExclusive(fresh, bindings)));
      }),
    );

  return {
    start: (input: StartRunInput, bindings) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const runId = input.runId ?? `run-${clock()}-${Math.random().toString(36).slice(2)}`;
          const existing = await loadRun(runId);
          if (existing) return existing;
          const ts = clock();
          await client.execute({
            sql: `INSERT INTO wf_run (run_id, scope, workflow, snapshot_id, entry_path, status, input, bindings, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
            args: [
              runId,
              input.scope,
              input.workflow,
              input.snapshotId,
              input.entryPath,
              JSON.stringify(input.input ?? {}),
              input.persistedBindings === undefined
                ? null
                : JSON.stringify(input.persistedBindings),
              ts,
              ts,
            ],
          });
          await appendEvent(runId, "run_created", null, input.input ?? {});
          return (await loadRun(runId))!;
        },
        catch: (cause) => new WorkflowError({ message: "start failed", cause }),
      }).pipe(Effect.flatMap((run) => driveExclusive(run, bindings))),

    resume: (runId, bindings) => resumeImpl(runId, bindings),

    signal: (runId, eventName, payload, bindings) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: `INSERT INTO wf_signal (run_id, event_name, payload) VALUES (?, ?, ?)
                  ON CONFLICT(run_id, event_name) DO UPDATE SET payload = excluded.payload`,
            args: [runId, eventName, payload === undefined ? null : JSON.stringify(payload)],
          });
          await appendEvent(runId, "signal", eventName, payload);
        },
        catch: (cause) => new WorkflowError({ message: "signal failed", cause }),
      }).pipe(Effect.flatMap(() => resumeImpl(runId, bindings))),

    cancel: (runId) =>
      Effect.tryPromise({
        try: async () => {
          await setRunStatus(runId, "cancelled");
          return (await loadRun(runId))! as RunView;
        },
        catch: (cause) => new WorkflowError({ message: "cancel failed", cause }),
      }),

    get: (runId) =>
      Effect.tryPromise({
        try: () => loadRun(runId) as Promise<RunView | null>,
        catch: (cause) => new WorkflowError({ message: "get failed", cause }),
      }),

    getPersisted: (runId) =>
      Effect.tryPromise({
        try: async () => {
          const run = await loadRun(runId);
          if (!run) return null;
          return {
            runId: run.runId,
            scope: run.scope,
            workflow: run.workflow,
            snapshotId: run.snapshotId,
            entryPath: run.entryPath,
            persistedBindings: run.persistedBindings,
          };
        },
        catch: (cause) => new WorkflowError({ message: "getPersisted failed", cause }),
      }),

    list: (filter) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const clauses: string[] = [];
          const args: unknown[] = [];
          if (filter?.scope) {
            clauses.push("scope = ?");
            args.push(filter.scope);
          }
          if (filter?.workflow) {
            clauses.push("workflow = ?");
            args.push(filter.workflow);
          }
          const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
          const res = await client.execute({
            sql: `SELECT run_id FROM wf_run ${where} ORDER BY created_at DESC`,
            args: args as never,
          });
          const views: RunView[] = [];
          for (const r of res.rows) {
            const v = await loadRun(String(r.run_id));
            if (v) views.push(v);
          }
          return views as readonly RunView[];
        },
        catch: (cause) => new WorkflowError({ message: "list failed", cause }),
      }),

    listSteps: (runId) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT name, status, output, error, attempt, completed_at FROM wf_step WHERE run_id = ? ORDER BY completed_at ASC, name ASC",
            args: [runId],
          });
          return res.rows.map((r) => ({
            runId,
            name: String(r.name),
            status: String(r.status) as StepView["status"],
            output: r.output != null ? JSON.parse(String(r.output)) : undefined,
            error: r.error != null ? String(r.error) : undefined,
            attempt: Number(r.attempt),
            completedAt: Number(r.completed_at),
          })) as readonly StepView[];
        },
        catch: (cause) => new WorkflowError({ message: "listSteps failed", cause }),
      }),

    close: () => Effect.sync(() => client.close()),
  };
};
