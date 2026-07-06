import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";
import type { Bindings } from "./bindings";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 5 regression: a suspended workflow must resume against the run's
// PINNED snapshot + the bindings it started with, NOT the latest publish + empty
// bindings. Before the fix, `signalWorkflow` loaded `requireDescriptor(scope)`
// (the latest publish) and passed `{}` bindings, so a workflow republished
// between start and signal ran DIFFERENT code with NO credentials on resume.
//
// The app has one tool `mark` (writes a `marks` row recording the version + the
// connection it was bound to) and one workflow `flow` that waits for an event
// then calls `mark`. We publish v1, start (it waits), publish a MODIFIED v2,
// then signal. The observable proof: the row written carries v1's marker and
// v1's binding, proving the ORIGINAL code + bindings ran.
// ---------------------------------------------------------------------------

const appFiles = (version: string): ReadonlyMap<string, string> =>
  new Map<string, string>([
    [
      "tools/mark.ts",
      `import { defineTool, connection } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "record a version marker",
  input: z.object({}),
  connections: { note: connection("notes") },
  async handler(_args, { note }) {
    // A real method call on the bound client -> routes through the resolver,
    // which records the CONNECTION used (proves which binding was applied). The
    // returned version proves which code (pinned snapshot) ran.
    const echoed = await note.record({ version: "${version}" });
    return { version: "${version}", echoed };
  },
});`,
    ],
    [
      "workflows/flow.ts",
      `import { defineWorkflow } from "executor:app";
export default defineWorkflow({
  description: "wait then mark",
  async run(step) {
    await step.waitForEvent("go");
    const out = await step.tool("mark", {});
    return out;
  },
});`,
    ],
  ]);

describe("workflow resume pins snapshot + bindings (Fix 5)", () => {
  it("resumes the ORIGINAL code + bindings after a republish + signal", async () => {
    const store = makeInMemoryAppsStore();
    // The resolver records the connection each `notes.record` call resolved to,
    // so `resolver.calls` proves WHICH binding was applied on resume.
    const resolver = makeTestResolver({ notes: { record: () => ({ ok: true }) } });
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-resume-")),
      store,
      resolver,
      inMemory: true,
    });
    const { runtime } = host;

    // Publish v1 and start the workflow with a v1 binding; it waits.
    await run(runtime.publish({ scope: "s", files: appFiles("v1") }));
    const v1Bindings: Bindings = { note: { kind: "single", connection: "conn-v1" } };
    const started = await run(
      runtime.startWorkflow({
        scope: "s",
        workflow: "flow",
        input: {},
        bindings: v1Bindings,
        runId: "resume-run",
      }),
    );
    expect(started.status).toBe("waiting");

    // Republish a MODIFIED v2 (different marker + would use different bindings).
    await run(runtime.publish({ scope: "s", files: appFiles("v2") }));

    // Signal to resume. This must use the run's pinned v1 snapshot + v1 bindings.
    const done = await run(
      runtime.signalWorkflow({ scope: "s", runId: "resume-run", event: "go", payload: {} }),
    );
    expect(done.status).toBe("completed");

    // The output is v1's marker (pinned snapshot ran, NOT the republished v2).
    expect((done.output as { version: string }).version).toBe("v1");

    // The resolver was called with the v1 binding ("conn-v1"), proving the
    // STORED bindings (not empty defaults) were used on resume. If the fix
    // regressed, resume would use `{}` bindings -> the default same-named
    // connection ("notes"), never "conn-v1".
    const noteCalls = resolver.calls.filter((c) => c.integration === "notes");
    expect(noteCalls.length).toBe(1);
    expect(noteCalls[0].connection).toBe("conn-v1");

    await host.close();
  }, 60_000);
});
