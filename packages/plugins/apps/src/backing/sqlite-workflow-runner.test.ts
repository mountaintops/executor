import { workflowRunnerConformance } from "../seams/workflow-runner.conformance";
import { makeSqliteWorkflowRunner } from "./sqlite-workflow-runner";

// A synthetic monotonic clock so sleep-based suspension is deterministic.
let t = 1_000_000;
workflowRunnerConformance("sqlite (in-memory)", () =>
  makeSqliteWorkflowRunner({ path: ":memory:", clock: () => (t += 1) }),
);
