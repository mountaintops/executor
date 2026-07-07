import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { artifactStoreConformance } from "../seams/artifact-store.conformance";
import { scopeAddress, scopeAddressStorageKey } from "../seams/scope-address";
import { compareAndSwapSnapshotRef, makeGitArtifactStore } from "./git-artifact-store";

artifactStoreConformance("git", () =>
  makeGitArtifactStore({ root: mkdtempSync(join(tmpdir(), "apps-artifacts-")) }),
);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("git ArtifactStore CAS", () => {
  it("returns a typed conflict when the expected head is stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "apps-artifacts-cas-"));
    const address = scopeAddress("org", "s");
    const scope = await run(makeGitArtifactStore({ root }).forScope(address));
    const first = await run(scope.commit(new Map([["tools/a.ts", "a"]]), "first"));
    await run(scope.commit(new Map([["tools/a.ts", "b"]]), "second"));

    const repoDir = join(root, `${scopeAddressStorageKey(address)}.git`);
    const exit = await Effect.runPromiseExit(
      compareAndSwapSnapshotRef(repoDir, String(first.id), String(first.id)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("publish conflict");
    expect(JSON.stringify(exit)).toContain('"conflict":true');
  });
});
