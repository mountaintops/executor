import { Effect } from "effect";

import {
  workflowRunnerConformance,
  type WorkflowConformanceHarness,
} from "../seams/workflow-runner.conformance";
import { makeSqliteWorkflowRunner } from "./sqlite-workflow-runner";
import { makeQuickjsWorkflowDriver } from "./quickjs-workflow-driver";
import { makeInMemoryArtifactStore } from "../testing/index";
import type { WorkflowBindings } from "../seams/workflow-runner";

// A synthetic monotonic clock so sleep-based suspension is deterministic. The
// runner drives the author body inside the QuickJS sandbox via the real driver,
// over an in-memory artifact store the harness publishes workflow sources into.
workflowRunnerConformance(
  "sqlite (in-memory) + quickjs driver",
  (bindings: WorkflowBindings): WorkflowConformanceHarness => {
    let t = 1_000_000;
    const artifactStore = makeInMemoryArtifactStore();
    const driver = makeQuickjsWorkflowDriver({ artifactStore });
    const runner = makeSqliteWorkflowRunner({
      path: ":memory:",
      driver,
      clock: () => (t += 1),
    });
    void bindings;
    return {
      runner,
      publish: async (name, source) => {
        const entryPath = `workflows/${name}.ts`;
        const store = await Effect.runPromise(artifactStore.forScope("s"));
        const meta = await Effect.runPromise(
          store.commit(new Map([[entryPath, source]]), `publish ${name}`),
        );
        return { snapshotId: meta.id, entryPath };
      },
    };
  },
);
