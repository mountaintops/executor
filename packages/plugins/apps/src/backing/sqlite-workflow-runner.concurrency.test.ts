import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeSqliteWorkflowRunner } from "./sqlite-workflow-runner";
import type {
  DriveOutcome,
  WorkflowBindings,
  WorkflowBridge,
  WorkflowDriver,
} from "../seams/workflow-runner";

// ---------------------------------------------------------------------------
// Finding 3 regression: a run driven concurrently (start + signal racing) must
// execute an unjournaled side-effecting `step.tool` EXACTLY once. Before the
// single-driver lease, both drivers loaded the same "step not journaled" view
// and both ran the tool, doubling its side effect.
//
// The stub driver drives one `step.tool("count")` per replay. The runner
// services it: the FIRST driver to hold the lease executes the tool (bumping the
// counter + journaling it); the second waits for the lease, re-drives, and finds
// the step journaled -> replays without re-executing. So no matter how the race
// interleaves, the counter ends at exactly 1.
// ---------------------------------------------------------------------------

const drivenTool: WorkflowDriver = {
  drive: (_input, bridge: WorkflowBridge): Effect.Effect<DriveOutcome, never> =>
    Effect.gen(function* () {
      // One side-effecting step per replay. The runner runs the bound tool only
      // when the step is NOT yet journaled.
      const res = yield* bridge.call({
        kind: "step.tool",
        step: "count",
        address: "count",
        args: {},
      });
      // A suspend/step-error result never happens for step.tool here; treat any
      // value as completion.
      const value = "value" in res ? res.value : undefined;
      return { status: "completed", output: value } satisfies DriveOutcome;
    }) as Effect.Effect<DriveOutcome, never>,
};

describe("WorkflowRunner single-driver lease (concurrent drive)", () => {
  it("executes an unjournaled step.tool exactly once under concurrent start+signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apps-wf-conc-"));
    const dbPath = join(dir, "journal.db");
    let t = 1_000_000;
    const runner = makeSqliteWorkflowRunner({
      path: dbPath,
      driver: drivenTool,
      clock: () => (t += 1),
    });

    // A side-effecting bound tool that increments a shared counter each time it
    // actually runs. If the run double-drives the unjournaled step, this bumps
    // twice.
    let counter = 0;
    const bindings: WorkflowBindings = {
      runTool: async () => {
        counter += 1;
        // A small yield so a racing driver has a real window to interleave.
        await new Promise((r) => setTimeout(r, 5));
        return counter;
      },
      notify: async () => {},
    };

    const runId = "race-run";
    // Fire start + signal concurrently, many times, all targeting the same run.
    // `start` is idempotent on runId (returns the existing run) and both paths
    // end up driving the run; the lease must still yield exactly one execution.
    const races: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      races.push(
        Effect.runPromise(
          runner
            .start(
              {
                scope: "s",
                workflow: "wf",
                snapshotId: "snap",
                entryPath: "workflows/wf.ts",
                input: {},
                runId,
              },
              bindings,
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
      races.push(
        Effect.runPromise(
          runner.signal(runId, "go", {}, bindings).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
    }
    await Promise.all(races);

    // The side effect ran exactly once.
    expect(counter).toBe(1);

    // And the step is journaled exactly once as completed.
    const steps = await Effect.runPromise(runner.listSteps(runId));
    const countSteps = steps.filter((s) => s.name === "count");
    expect(countSteps.length).toBe(1);
    expect(countSteps[0]?.status).toBe("completed");

    await Effect.runPromise(runner.close());
  }, 30_000);
});
