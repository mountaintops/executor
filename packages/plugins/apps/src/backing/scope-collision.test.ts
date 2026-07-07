import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeSqliteAppsStore } from "./sqlite-apps-store";
import { DESCRIPTOR_VERSION, type AppDescriptor } from "../pipeline/descriptor";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 9 regression: scopes that differ only by a character an old naming
// scheme collapsed ("my-scope" vs "my_scope") must not share descriptor
// storage.
// ---------------------------------------------------------------------------

describe("scope collision (Fix 9)", () => {
  it("stores distinct descriptor scopes independently", async () => {
    const store = makeSqliteAppsStore({ path: ":memory:" });
    const descriptor = (scope: string): AppDescriptor => ({
      version: DESCRIPTOR_VERSION,
      tenant: "org",
      scope,
      description: "test",
      snapshotId: `${scope}-snapshot`,
      toolchain: { bundler: "esbuild", bundlerVersion: "test", target: "test" },
      tools: [],
      workflows: [],
      ui: [],
      skills: [],
      skipped: [],
    });

    await run(store.putDescriptor("org", "org", descriptor("my-scope")));
    await run(store.putDescriptor("org", "org", descriptor("my_scope")));

    expect((await run(store.getDescriptor("org", "my-scope")))?.scope).toBe("my-scope");
    expect((await run(store.getDescriptor("org", "my_scope")))?.scope).toBe("my_scope");
  });
});
