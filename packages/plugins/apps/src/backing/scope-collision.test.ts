import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeLibsqlScopeDb } from "./libsql-scope-db";
import { makeSqliteAppsStore } from "./sqlite-apps-store";
import { DESCRIPTOR_VERSION, type AppDescriptor } from "../pipeline/descriptor";
import { scopeAddress } from "../seams/scope-address";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 9 regression: scopes that differ only by a character the old naming
// collapsed ("my-scope" vs "my_scope") must NOT share a database, and the
// connection->scope mapping must route each to its own scope. Before the fix the
// scope-db filename collapsed `[^A-Za-z0-9._-]` to `_` (colliding two scopes onto
// one file) and the connection name was reverse-parsed (colliding two scopes onto
// one normalized identifier).
// ---------------------------------------------------------------------------

describe("scope collision (Fix 9)", () => {
  it("gives my-scope and my_scope DISTINCT scope-db files with isolated data", async () => {
    const root = mkdtempSync(join(tmpdir(), "apps-scopecol-"));
    const db = makeLibsqlScopeDb({ root });

    const a = await run(db.forScope(scopeAddress("org", "my-scope")));
    await run(a.exec("CREATE TABLE t (v TEXT)"));
    await run(a.exec("INSERT INTO t (v) VALUES ('a')"));

    const b = await run(db.forScope(scopeAddress("org", "my_scope")));
    await run(b.exec("CREATE TABLE t (v TEXT)"));
    await run(b.exec("INSERT INTO t (v) VALUES ('b')"));

    // Each scope sees ONLY its own row (no shared file).
    const aRows = await run(a.exec<{ v: string }>("SELECT v FROM t"));
    const bRows = await run(b.exec<{ v: string }>("SELECT v FROM t"));
    expect(aRows.map((r) => r.v)).toEqual(["a"]);
    expect(bRows.map((r) => r.v)).toEqual(["b"]);

    // Two distinct .db files exist on disk.
    const dbFiles = readdirSync(root).filter((f) => f.endsWith(".db"));
    expect(dbFiles.length).toBe(2);

    await run(db.close());
  });

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
