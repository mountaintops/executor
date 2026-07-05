import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { WorkflowBindings, WorkflowRunner } from "./workflow-runner";

// ---------------------------------------------------------------------------
// WorkflowRunner conformance suite. Runs against the interface with DATA, never
// a closure: each test seeds a workflow SOURCE into the store, then drives the
// run by (snapshotId, entryPath). The author body runs inside the sandbox via
// the WorkflowDriver, exactly as it does in production. Covers:
//   - step memoization (a step body runs exactly once across replays)
//   - sleep suspends then resumes past the sleep
//   - waitForEvent suspends; signal delivers and resumes
//   - step.tool routes through the bindings and journals
//   - retry semantics (RetryableError leaves the run re-drivable)
// The real SIGKILL kill test lives in its own file (needs a child process).
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** The seam a conformance harness provides: a runner plus a way to publish a
 *  named workflow source and get back the (snapshotId, entryPath) to start it,
 *  and the bindings the run reaches out through. */
export interface WorkflowConformanceHarness {
  readonly runner: WorkflowRunner;
  /** Publish a workflow's author source; returns the DATA `start` needs. */
  readonly publish: (
    name: string,
    source: string,
  ) => Promise<{ snapshotId: string; entryPath: string }>;
}

export const workflowRunnerConformance = (
  name: string,
  makeHarness: (bindings: WorkflowBindings) => WorkflowConformanceHarness,
): void => {
  describe(`WorkflowRunner conformance: ${name}`, () => {
    it("memoizes a step: replay does not re-execute it", async () => {
      let sideEffects = 0;
      const bindings: WorkflowBindings = {
        // A step.tool call stands in for the observable side effect: it must run
        // exactly once even though the body replays after the sleep.
        runTool: async () => {
          sideEffects++;
          return 10;
        },
        notify: async () => {},
      };
      const { runner, publish } = makeHarness(bindings);
      const src = `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  async run(step) {
    const a = await step.tool("side-effect", {});
    await step.sleep("nap", 1);
    const b = await step.do("b", async () => a + 5);
    return { a, b };
  },
});`;
      const { snapshotId, entryPath } = await publish("memo", src);

      const started = await run(
        runner.start(
          { scope: "s", workflow: "memo", snapshotId, entryPath, input: {}, runId: "r1" },
          bindings,
        ),
      );
      expect(started.status).toBe("sleeping");
      expect(sideEffects).toBe(1);

      const resumed = await run(runner.resume("r1", bindings));
      expect(resumed.status).toBe("completed");
      expect(resumed.output).toEqual({ a: 10, b: 15 });
      // The tool ran exactly once despite the resume.
      expect(sideEffects).toBe(1);
      await run(runner.close());
    });

    it("suspends on waitForEvent and resumes on signal with the payload", async () => {
      const bindings: WorkflowBindings = { runTool: async () => ({}), notify: async () => {} };
      const { runner, publish } = makeHarness(bindings);
      const src = `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  async run(step) {
    const approval = await step.waitForEvent("approval");
    return { approved: approval.ok };
  },
});`;
      const { snapshotId, entryPath } = await publish("wait", src);
      const started = await run(
        runner.start(
          { scope: "s", workflow: "wait", snapshotId, entryPath, input: {}, runId: "rw" },
          bindings,
        ),
      );
      expect(started.status).toBe("waiting");

      const done = await run(runner.signal("rw", "approval", { ok: true }, bindings));
      expect(done.status).toBe("completed");
      expect(done.output).toEqual({ approved: true });
      await run(runner.close());
    });

    it("runs step.tool through the bindings and journals it", async () => {
      const calls: { address: string; args: unknown }[] = [];
      const bindings: WorkflowBindings = {
        runTool: async (address, args) => {
          calls.push({ address, args });
          return { synced: 3 };
        },
        notify: async () => {},
      };
      const { runner, publish } = makeHarness(bindings);
      const src = `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  async run(step) {
    const r = await step.tool("issues-sync", {});
    return { synced: r.synced };
  },
});`;
      const { snapshotId, entryPath } = await publish("tool", src);
      const done = await run(
        runner.start(
          { scope: "s", workflow: "tool", snapshotId, entryPath, input: {}, runId: "rt" },
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
      // The bound "attempt" tool throws a RetryableError on the first drive and
      // succeeds on the second. A retryable step error is NOT journaled, so the
      // resume re-runs it; the memoized "stable" step replays without re-running.
      let attempts = 0;
      let stableRuns = 0;
      const bindings: WorkflowBindings = {
        runTool: async (address) => {
          if (address === "attempt") {
            attempts++;
            if (attempts < 2) {
              const e = new Error("flaky") as Error & { retryable?: boolean };
              e.retryable = true;
              throw e;
            }
            return attempts;
          }
          return null;
        },
        notify: async () => {},
      };
      const { runner, publish } = makeHarness(bindings);
      const src = `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  async run(step) {
    await step.do("stable", async () => { globalThis.__markStable && globalThis.__markStable(); return "ok"; });
    const attempt = await step.tool("attempt", {});
    return { attempts: attempt };
  },
});`;
      // The sandbox can't touch our closure; count "stable" re-runs via the
      // journal instead. We assert it stays journaled (see listSteps below).
      void stableRuns;
      const { snapshotId, entryPath } = await publish("retry", src);
      const first = await run(
        runner.start(
          { scope: "s", workflow: "retry", snapshotId, entryPath, input: {}, runId: "rr" },
          bindings,
        ),
      );
      expect(first.status).toBe("running");
      const second = await run(runner.resume("rr", bindings));
      expect(second.status).toBe("completed");
      expect(second.output).toEqual({ attempts: 2 });
      // "stable" was journaled once and never re-recorded across the retry.
      const steps = await run(runner.listSteps("rr"));
      expect(steps.filter((s) => s.name === "stable").length).toBe(1);
      await run(runner.close());
    });
  });
};
