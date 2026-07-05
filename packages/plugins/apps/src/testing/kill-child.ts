// ---------------------------------------------------------------------------
// Kill-test child harness. Invoked as a subprocess by
// sqlite-workflow-runner.kill.test.ts. It runs the SAME workflow body over the
// SAME journal DB across two phases:
//
//   phase=1  start the run. Step "write-once" appends one line to the marker
//            file (the exactly-once side effect), then step "hang" blocks
//            forever. The parent SIGKILLs this process while "hang" is running,
//            so "hang" is never journaled.
//   phase=2  resume the run over the same DB. "write-once" is journaled ->
//            replays WITHOUT re-running (no second marker line). "hang" is now
//            fast and completes the run.
//
// Assertion (in the parent): the marker file has exactly ONE line after both
// phases — the completed step's side effect happened exactly once despite the
// kill+restart.
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";

import { Effect } from "effect";

import { makeSqliteWorkflowRunner } from "../backing/sqlite-workflow-runner";
import type { DurableSteps, WorkflowBindings } from "../seams/workflow-runner";

const [, , phase, dbPath, markerPath] = process.argv;

const bindings: WorkflowBindings = {
  runTool: async () => ({}),
  notify: async () => {},
};

const body = async (steps: DurableSteps) => {
  // The exactly-once side effect: appended only when the step actually runs.
  await steps.do("write-once", async () => {
    appendFileSync(markerPath, "ran\n");
    return { wrote: true };
  });
  if (phase === "1") {
    // Hang forever inside a NOT-yet-journaled step; the parent kills us here.
    // Signal readiness first so the parent knows the side effect happened.
    process.stdout.write("HUNG\n");
    await steps.do("hang", async () => {
      await new Promise(() => {
        /* never resolves */
      });
      return {};
    });
  }
  return { done: true };
};

const runner = makeSqliteWorkflowRunner({ path: dbPath });

const main = async () => {
  if (phase === "1") {
    await Effect.runPromise(
      runner.start(
        { scope: "s", workflow: "kill-wf", snapshotId: "snap", input: {}, runId: "kill-run" },
        body,
        bindings,
      ),
    );
  } else {
    const view = await Effect.runPromise(runner.resume("kill-run", body, bindings));
    process.stdout.write(`STATUS:${view.status}\n`);
    await Effect.runPromise(runner.close());
  }
};

void main();
