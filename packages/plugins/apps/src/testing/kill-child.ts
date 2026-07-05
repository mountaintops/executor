// ---------------------------------------------------------------------------
// Kill-test child harness. Invoked as a subprocess by
// sqlite-workflow-runner.kill.test.ts. It runs the SAME published workflow over
// the SAME journal DB across two phases, driving the body inside the SANDBOX
// (the orchestrator is sandboxed now — the body never runs in this process).
//
//   phase=1  start the run. Step "write-once" is a step.tool whose bound tool
//            appends one line to the marker file (the exactly-once side effect),
//            then step "hang" (a step.tool) blocks forever. The parent SIGKILLs
//            this process while "hang" is running, so "hang" is never journaled.
//   phase=2  resume the run over the same DB. "write-once" is journaled ->
//            replays WITHOUT re-running its bound tool (no second marker line).
//            "hang" now completes fast and the run finishes.
//
// Assertion (in the parent): the marker file has exactly ONE line after both
// phases — the completed step's host-side side effect happened exactly once
// despite the kill+restart, with a SANDBOXED orchestrator.
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";

import { Effect } from "effect";

import { makeSqliteWorkflowRunner } from "../backing/sqlite-workflow-runner";
import { makeQuickjsWorkflowDriver } from "../backing/quickjs-workflow-driver";
import { makeInMemoryArtifactStore } from "./index";
import type { WorkflowBindings } from "../seams/workflow-runner";

const [, , phase, dbPath, markerPath] = process.argv;

// The workflow SOURCE: runs in the sandbox. The exactly-once side effect and the
// hang both cross the bridge as step.tool calls serviced host-side below.
const WORKFLOW_SOURCE = `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  async run(step) {
    await step.tool("write-once", {});
    await step.tool("hang", {});
    return { done: true };
  },
});`;

const bindings: WorkflowBindings = {
  runTool: async (address) => {
    if (address === "write-once") {
      // The exactly-once side effect: only when the step actually runs.
      appendFileSync(markerPath, "ran\n");
      return { wrote: true };
    }
    if (address === "hang") {
      if (phase === "1") {
        // Signal readiness so the parent knows the side effect landed, then hang
        // forever inside this NOT-yet-journaled step; the parent kills us here.
        process.stdout.write("HUNG\n");
        await new Promise(() => {
          /* never resolves */
        });
      }
      return { hung: false };
    }
    return {};
  },
  notify: async () => {},
};

const main = async () => {
  const artifactStore = makeInMemoryArtifactStore();
  const driver = makeQuickjsWorkflowDriver({ artifactStore });
  const runner = makeSqliteWorkflowRunner({ path: dbPath, driver });

  const entryPath = "workflows/kill-wf.ts";
  const store = await Effect.runPromise(artifactStore.forScope("s"));
  const meta = await Effect.runPromise(
    store.commit(new Map([[entryPath, WORKFLOW_SOURCE]]), "publish kill-wf"),
  );

  if (phase === "1") {
    await Effect.runPromise(
      runner.start(
        {
          scope: "s",
          workflow: "kill-wf",
          snapshotId: meta.id,
          entryPath,
          input: {},
          runId: "kill-run",
        },
        bindings,
      ),
    );
  } else {
    const view = await Effect.runPromise(runner.resume("kill-run", bindings));
    process.stdout.write(`STATUS:${view.status}\n`);
    await Effect.runPromise(runner.close());
  }
};

void main();
