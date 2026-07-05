import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect } from "effect";

import {
  FatalError,
  RetryableError,
  WorkflowError,
  type DurableSteps,
  type RunView,
  type StartRunInput,
  type StepView,
  type WorkflowBindings,
  type WorkflowRunner,
} from "../seams/workflow-runner";

// ---------------------------------------------------------------------------
// SQLite journal replay WorkflowRunner (self-hosted).
//
// An append-only event journal in SQLite backs materialized run/step views
// (modeled on vercel/workflow's World Storage contract). The workflow body runs
// via `execute(steps)`; each `steps.do/tool/sleep/waitForEvent` FIRST consults
// the journal:
//   - a completed step replays its recorded result WITHOUT re-executing
//   - the first not-yet-recorded step actually executes, appends its result
//   - `sleep`/`waitForEvent` throw a typed Suspend that unwinds the body; the
//     run is marked sleeping/waiting and `resume`/`signal` re-drives it later
//
// This is what makes the kill test pass: SIGKILL mid-step -> restart over the
// same DB file -> `resume` replays completed steps from the journal and only
// the interrupted (never-recorded) step runs again. A side-effect from a
// COMPLETED step happens exactly once.
//
// `step.tool` and `step.notify` reach the outside world through the
// caller-supplied `WorkflowBindings`, bound to the run's snapshot + scope + the
// real tool-invoke/audit path.
// ---------------------------------------------------------------------------

const nowMs = () => Date.now();

/** Control-flow signal to unwind the body at a sleep/wait boundary. Caught by
 *  the runner; never seen by the author. */
class Suspend {
  constructor(
    readonly reason: "sleep" | "wait",
    readonly wakeAt?: number,
    readonly eventName?: string,
  ) {}
}

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wf_run (
  run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, workflow TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL,
  output TEXT, error TEXT, wake_at INTEGER, wait_event TEXT,
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
`;

interface StepRecord {
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
  attempt: number;
}

export interface SqliteWorkflowRunnerOptions {
  /** Journal DB path, or ":memory:". A file path is what the kill test needs. */
  readonly path: string;
  /** Injected clock for deterministic sleep in tests. */
  readonly clock?: () => number;
}

export const makeSqliteWorkflowRunner = (options: SqliteWorkflowRunnerOptions): WorkflowRunner => {
  if (options.path !== ":memory:") mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const client: Client = createClient({ url: toUrl(options.path) });
  const clock = options.clock ?? nowMs;
  let ready: Promise<void> | undefined;

  const init = async () => {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA.split(";")) {
          const s = stmt.trim();
          if (s) await client.execute(s);
        }
      })();
    }
    return ready;
  };

  const loadRun = async (runId: string): Promise<RunView | null> => {
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
      status: String(row.status) as RunView["status"],
      input: JSON.parse(String(row.input)),
      output: row.output != null ? JSON.parse(String(row.output)) : undefined,
      error: row.error != null ? String(row.error) : undefined,
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

  const makeSteps = (
    runId: string,
    journaled: Map<string, StepRecord>,
    bindings: WorkflowBindings,
  ): DurableSteps => {
    const replayOrRun = async <T>(name: string, exec: () => Promise<T>): Promise<T> => {
      const existing = journaled.get(name);
      if (existing) {
        if (existing.status === "failed") {
          throw new FatalError({ message: existing.error ?? `step ${name} failed` });
        }
        return existing.output as T;
      }
      let output: T;
      try {
        output = await exec();
      } catch (cause) {
        if (cause instanceof Suspend) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        const record: StepRecord = { status: "failed", error: message, attempt: 1 };
        journaled.set(name, record);
        await recordStep(runId, name, record);
        throw new FatalError({ message });
      }
      const record: StepRecord = { status: "completed", output, attempt: 1 };
      journaled.set(name, record);
      await recordStep(runId, name, record);
      return output;
    };

    return {
      do: <T>(name: string, fn: () => Promise<T> | T) =>
        replayOrRun(name, async () => (await fn()) as T),
      tool: <T = unknown>(address: string, args: Record<string, unknown>) =>
        replayOrRun<T>(`tool:${address}`, () => bindings.runTool(address, args) as Promise<T>),
      sleep: async (name: string, ms: number) => {
        if (journaled.get(`sleep:${name}`)) return;
        const wakeAt = clock() + ms;
        const record: StepRecord = { status: "completed", output: { wakeAt }, attempt: 1 };
        journaled.set(`sleep:${name}`, record);
        await recordStep(runId, `sleep:${name}`, record);
        throw new Suspend("sleep", wakeAt);
      },
      waitForEvent: async <T = unknown>(name: string) => {
        const delivered = journaled.get(`wait:${name}`);
        if (delivered) return delivered.output as T;
        const sig = await client.execute({
          sql: "SELECT payload FROM wf_signal WHERE run_id = ? AND event_name = ?",
          args: [runId, name],
        });
        if (sig.rows[0]) {
          const payload =
            sig.rows[0].payload != null ? JSON.parse(String(sig.rows[0].payload)) : undefined;
          const record: StepRecord = { status: "completed", output: payload, attempt: 1 };
          journaled.set(`wait:${name}`, record);
          await recordStep(runId, `wait:${name}`, record);
          return payload as T;
        }
        throw new Suspend("wait", undefined, name);
      },
      notify: async (msg: { title: string; body?: string; link?: string }) => {
        await replayOrRun(`notify:${msg.title}`, async () => {
          await bindings.notify(msg);
          return { notified: true };
        });
      },
    };
  };

  const drive = (
    runId: string,
    execute: (steps: DurableSteps) => Promise<unknown>,
    bindings: WorkflowBindings,
  ): Effect.Effect<RunView, WorkflowError> =>
    Effect.tryPromise({
      try: async () => {
        await init();
        const journaled = await loadSteps(runId);
        const steps = makeSteps(runId, journaled, bindings);
        try {
          const output = await execute(steps);
          await setRunStatus(runId, "completed", { output });
        } catch (cause) {
          if (cause instanceof Suspend) {
            if (cause.reason === "sleep") {
              await setRunStatus(runId, "sleeping", { wakeAt: cause.wakeAt });
            } else {
              await setRunStatus(runId, "waiting", { waitEvent: cause.eventName });
            }
          } else if (cause instanceof RetryableError) {
            await setRunStatus(runId, "running");
          } else {
            const message = cause instanceof Error ? cause.message : String(cause);
            await setRunStatus(runId, "failed", { error: message });
          }
        }
        return (await loadRun(runId))!;
      },
      catch: (cause) => new WorkflowError({ message: "workflow drive failed", cause }),
    });

  const resumeImpl = (
    runId: string,
    execute: (steps: DurableSteps) => Promise<unknown>,
    bindings: WorkflowBindings,
  ): Effect.Effect<RunView, WorkflowError> =>
    Effect.tryPromise({
      try: () => loadRun(runId),
      catch: (cause) => new WorkflowError({ message: "resume load failed", cause }),
    }).pipe(
      Effect.flatMap((view) => {
        if (!view) return Effect.fail(new WorkflowError({ message: `no run ${runId}` }));
        if (
          view.status === "completed" ||
          view.status === "failed" ||
          view.status === "cancelled"
        ) {
          return Effect.succeed(view);
        }
        return Effect.tryPromise({
          try: async () => {
            await setRunStatus(runId, "running");
          },
          catch: (cause) => new WorkflowError({ message: "resume set-running failed", cause }),
        }).pipe(Effect.flatMap(() => drive(runId, execute, bindings)));
      }),
    );

  return {
    start: (input: StartRunInput, execute, bindings) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const runId = input.runId ?? `run-${clock()}-${Math.random().toString(36).slice(2)}`;
          const existing = await loadRun(runId);
          if (existing) return runId;
          const ts = clock();
          await client.execute({
            sql: `INSERT INTO wf_run (run_id, scope, workflow, snapshot_id, status, input, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
            args: [
              runId,
              input.scope,
              input.workflow,
              input.snapshotId,
              JSON.stringify(input.input ?? {}),
              ts,
              ts,
            ],
          });
          await appendEvent(runId, "run_created", null, input.input ?? {});
          return runId;
        },
        catch: (cause) => new WorkflowError({ message: "start failed", cause }),
      }).pipe(Effect.flatMap((runId) => drive(runId, execute, bindings))),

    resume: (runId, execute, bindings) => resumeImpl(runId, execute, bindings),

    signal: (runId, eventName, payload, execute, bindings) =>
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
      }).pipe(Effect.flatMap(() => resumeImpl(runId, execute, bindings))),

    cancel: (runId) =>
      Effect.tryPromise({
        try: async () => {
          await setRunStatus(runId, "cancelled");
          return (await loadRun(runId))!;
        },
        catch: (cause) => new WorkflowError({ message: "cancel failed", cause }),
      }),

    get: (runId) =>
      Effect.tryPromise({
        try: () => loadRun(runId),
        catch: (cause) => new WorkflowError({ message: "get failed", cause }),
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
