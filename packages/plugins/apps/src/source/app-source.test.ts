import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { PUBLISH_LIMITS } from "../pipeline/publish";
import { fetchGitHubAppSource, parseGitHubSourceUrl } from "./github-source";
import { fetchLocalDirectoryAppSource } from "./local-directory-source";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeGitHubFetch = (files: ReadonlyMap<string, string>) => {
  const repoPath = "/repos/acme/tools";
  const entries = [...files].map(([path, content], index) => ({
    path,
    type: "blob",
    mode: "100644",
    sha: `blob-${index}`,
    size: new TextEncoder().encode(content).byteLength,
  }));
  let blobCalls = 0;
  const fetch = (async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === repoPath) return json({ default_branch: "main" });
    if (url.pathname === `${repoPath}/git/ref/heads%2Fmain`) {
      return json({ object: { sha: "commit-1" } });
    }
    if (url.pathname === `${repoPath}/git/commits/commit-1`) {
      return json({ sha: "commit-1", tree: { sha: "tree-1" } });
    }
    if (url.pathname === `${repoPath}/git/trees/tree-1`) return json({ tree: entries });
    const blobPrefix = `${repoPath}/git/blobs/`;
    if (url.pathname.startsWith(blobPrefix)) {
      blobCalls += 1;
      const sha = decodeURIComponent(url.pathname.slice(blobPrefix.length));
      const entry = entries.find((item) => item.sha === sha);
      const content = entry ? files.get(entry.path) : undefined;
      return content === undefined
        ? json({ message: "not found" }, 404)
        : json({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, blobCalls: () => blobCalls };
};

describe("app sources", () => {
  it("parses GitHub source URLs", () => {
    expect(parseGitHubSourceUrl("https://github.com/acme/tools/tree/main")).toEqual({
      ok: true,
      value: {
        owner: "acme",
        name: "tools",
        repo: "acme/tools",
        ref: "main",
        url: "https://github.com/acme/tools/tree/main",
      },
    });
    expect(parseGitHubSourceUrl("https://gitlab.com/acme/tools")).toEqual({
      ok: false,
      message: "GitHub source URLs must use github.com.",
    });
  });

  it("fetches relevant GitHub files and skips unsupported folders", async () => {
    const github = makeGitHubFetch(
      new Map([
        ["executor.json", JSON.stringify({ description: "Acme tools" })],
        ["package.json", JSON.stringify({ dependencies: { zod: "4.3.6" } })],
        ["tools/hello.ts", "export default {};"],
        ["workflows/later.ts", "export default {};"],
      ]),
    );
    const source = await run(
      fetchGitHubAppSource({ url: "https://github.com/acme/tools", fetch: github.fetch }),
    );
    expect(source.sourceRef).toBe("commit-1");
    expect(source.description).toBe("Acme tools");
    expect(source.files.map((file) => file.path).sort()).toEqual([
      "executor.json",
      "package.json",
      "tools/hello.ts",
    ]);
    expect(source.skipped).toContainEqual({
      path: "workflows/later.ts",
      reason: "not supported yet",
    });
  });

  it("rejects oversized GitHub trees before fetching blobs", async () => {
    const files = new Map<string, string>();
    for (let index = 0; index < PUBLISH_LIMITS.maxFiles + 1; index += 1) {
      files.set(`tools/t${index}.ts`, "export default {};");
    }
    const github = makeGitHubFetch(files);
    const exit = await Effect.runPromiseExit(
      fetchGitHubAppSource({ url: "https://github.com/acme/tools", fetch: github.fetch }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(github.blobCalls()).toBe(0);
  });

  it("reads local directories and hashes content deterministically", async () => {
    const root = await mkdtemp();
    await mkdir(join(root, "tools"));
    await mkdir(join(root, "workflows"));
    await writeFile(join(root, "executor.json"), JSON.stringify({ description: "Local tools" }));
    await writeFile(join(root, "tools", "hello.ts"), "export default {};");
    await writeFile(join(root, "workflows", "later.ts"), "export default {};");
    await symlink(join(root, "tools", "hello.ts"), join(root, "tools", "link.ts"));

    const first = await run(fetchLocalDirectoryAppSource({ path: root }));
    const second = await run(fetchLocalDirectoryAppSource({ path: root }));
    expect(first.sourceRef).toBe(second.sourceRef);
    expect(first.description).toBe("Local tools");
    expect(first.files.map((file) => file.path).sort()).toEqual([
      "executor.json",
      "tools/hello.ts",
    ]);
    expect(first.skipped).toContainEqual({
      path: "tools/link.ts",
      reason: "unsupported file type",
    });
    expect(first.skipped).toContainEqual({
      path: "workflows/later.ts",
      reason: "not supported yet",
    });
  });

  it("rejects unsafe local-directory paths", async () => {
    const relative = await Effect.runPromiseExit(
      fetchLocalDirectoryAppSource({ path: "relative" }),
    );
    const parent = await Effect.runPromiseExit(
      fetchLocalDirectoryAppSource({ path: "/tmp/../bad" }),
    );
    expect(Exit.isFailure(relative)).toBe(true);
    expect(Exit.isFailure(parent)).toBe(true);
  });
});

const mkdtemp = (): Promise<string> =>
  import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "apps-src-")));
