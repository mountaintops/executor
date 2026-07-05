import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  RetryableError,
  type DurableSteps,
  type WorkflowBindings,
  type WorkflowRunner,
} from "./workflow-runner";

// ---------------------------------------------------------------------------
// WorkflowRunner conformance suite. Runs against the interface. Covers:
//   - step memoization (a step body runs exactly once across replays)
//   - sleep suspends then resumes past the sleep
//   - waitForEvent suspends; signal delivers and resumes
//   - retry semantics (RetryableError leaves the run re-drivable)
// The real SIGKILL kill test lives in its own file (needs a child process).
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const noBindings: WorkflowBindings = {
  runTool: async () => ({}),
  notify: async () => {},
};

export const workflowRunnerConformance = (name: string, makeRunner: () => WorkflowRunner): void => {
  describe(`WorkflowRunner conformance: ${name}`, () => {
    it("memoizes a step: replay does not re-execute it", async () => {
      const runner = makeRunner();
      let sideEffects = 0;
      const body = async (steps: DurableSteps) => {
        const a = await steps.do("a", async () => {
          sideEffects++;
          return 10;
        });
        // A sleep suspends after step a; on resume, a must NOT re-run.
        await steps.sleep("nap", 1);
        const b = await steps.do("b", async () => a + 5);
        return { a, b };
      };

      const started = await run(
        runner.start(
          { scope: "s", workflow: "wf", snapshotId: "snap1", input: {}, runId: "r1" },
          body,
          noBindings,
        ),
      );
      expect(started.status).toBe("sleeping");
      expect(sideEffects).toBe(1);

      const resumed = await run(runner.resume("r1", body, noBindings));
      expect(resumed.status).toBe("completed");
      expect(resumed.output).toEqual({ a: 10, b: 15 });
      // Step "a" ran exactly once despite the resume.
      expect(sideEffects).toBe(1);
      await run(runner.close());
    });

    it("suspends on waitForEvent and resumes on signal with the payload", async () => {
      const runner = makeRunner();
      const body = async (steps: DurableSteps) => {
        const approval = await steps.waitForEvent<{ ok: boolean }>("approval");
        return { approved: approval.ok };
      };
      const started = await run(
        runner.start(
          { scope: "s", workflow: "wf", snapshotId: "snap1", input: {}, runId: "rw" },
          body,
          noBindings,
        ),
      );
      expect(started.status).toBe("waiting");

      const done = await run(runner.signal("rw", "approval", { ok: true }, body, noBindings));
      expect(done.status).toBe("completed");
      expect(done.output).toEqual({ approved: true });
      await run(runner.close());
    });

    it("runs step.tool through the bindings and journals it", async () => {
      const runner = makeRunner();
      const calls: { address: string; args: unknown }[] = [];
      const bindings: WorkflowBindings = {
        runTool: async (address, args) => {
          calls.push({ address, args });
          return { synced: 3 };
        },
        notify: async () => {},
      };
      const body = async (steps: DurableSteps) => {
        const r = await steps.tool<{ synced: number }>("issues-sync", {});
        return { synced: r.synced };
      };
      const done = await run(
        runner.start(
          { scope: "s", workflow: "wf", snapshotId: "snap1", input: {}, runId: "rt" },
          body,
          bindings,
        ),
      );
      expect(done.status).toBe("completed");
      expect(done.output).toEqual({ synced: 3 });
      expect(calls).toEqual([{ address: "issues-sync", args: {} }]);

      const steps = await run(runner.listSteps("rt"));
      expect(steps.some((s) => s.name === "tool:issues-sync" && s.status === "completed")).toBe(
        true,
      );
      await run(runner.close());
    });

    it("leaves the run re-drivable on RetryableError", async () => {
      const runner = makeRunner();
      let attempts = 0;
      const body = async (steps: DurableSteps) => {
        await steps.do("stable", async () => "ok");
        attempts++;
        if (attempts < 2) throw new RetryableError({ message: "flaky" });
        return { attempts };
      };
      const first = await run(
        runner.start(
          { scope: "s", workflow: "wf", snapshotId: "snap1", input: {}, runId: "rr" },
          body,
          noBindings,
        ),
      );
      expect(first.status).toBe("running");
      const second = await run(runner.resume("rr", body, noBindings));
      expect(second.status).toBe("completed");
      expect(second.output).toEqual({ attempts: 2 });
      await run(runner.close());
    });
  });
};
