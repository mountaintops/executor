import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";
import { PUBLISH_LIMITS } from "../pipeline/publish";
import { fetchGitHubSource, syncGitHubSource } from "./github-source";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const toolSource = (name = "ok"): string => `import { defineTool } from "executor:app";
import { z } from "zod";
export default defineTool({
  description: "${name}",
  input: z.object({ value: z.string().default("${name}") }),
  async handler(input) { return { value: input.value }; },
});`;

const makeRuntime = () =>
  makeSelfHostAppsRuntime({
    dataDir: mkdtempSync(join(tmpdir(), "apps-gh-src-")),
    store: makeInMemoryAppsStore(),
    resolver: makeTestResolver({}),
    inMemory: true,
  });

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeGitHubFetch = (input: {
  readonly files: ReadonlyMap<string, string>;
  readonly upstreamSha?: string;
  readonly treeSha?: string;
}) => {
  const repoPath = "/repos/acme/tools";
  const upstreamSha = input.upstreamSha ?? "commit-1";
  const treeSha = input.treeSha ?? "tree-1";
  const blobBySha = new Map<string, { path: string; content: string }>();
  let index = 0;
  for (const [path, content] of input.files) {
    blobBySha.set(`blob-${++index}`, { path, content });
  }
  let blobCalls = 0;
  const fetch = (async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname === repoPath) return json({ default_branch: "main" });
    if (url.pathname === `${repoPath}/git/ref/heads%2Fmain`) {
      return json({ object: { sha: upstreamSha } });
    }
    if (url.pathname === `${repoPath}/git/commits/${upstreamSha}`) {
      return json({ sha: upstreamSha, tree: { sha: treeSha } });
    }
    if (url.pathname === `${repoPath}/git/trees/${treeSha}`) {
      return json({
        tree: [...blobBySha.entries()].map(([sha, blob]) => ({
          path: blob.path,
          type: "blob",
          sha,
          size: Buffer.byteLength(blob.content, "utf8"),
        })),
      });
    }
    const blobPrefix = `${repoPath}/git/blobs/`;
    if (url.pathname.startsWith(blobPrefix)) {
      blobCalls++;
      const sha = decodeURIComponent(url.pathname.slice(blobPrefix.length));
      const blob = blobBySha.get(sha);
      if (!blob) return json({ message: "not found" }, 404);
      return json({
        encoding: "base64",
        content: Buffer.from(blob.content, "utf8").toString("base64"),
      });
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    blobCalls: () => blobCalls,
  };
};

describe("GitHub custom-tools source", () => {
  it("fetches a repo fileset and publishes provenance, description, and skipped entries", async () => {
    const files = new Map<string, string>([
      [
        "executor.json",
        JSON.stringify({
          $schema: "https://example.test/schema",
          description: "Acme tools",
          ignored: true,
        }),
      ],
      ["tools/hello.ts", toolSource("hello")],
      ["workflows/deferred.ts", "export default {};"],
      ["docs/readme.md", "ignored"],
    ]);
    const github = makeGitHubFetch({ files, upstreamSha: "commit-a" });
    const snapshot = await run(fetchGitHubSource({ repo: "acme/tools", fetch: github.fetch }));
    expect([...snapshot.files.keys()].sort()).toEqual([
      "executor.json",
      "tools/hello.ts",
      "workflows/deferred.ts",
    ]);
    expect(snapshot.description).toBe("Acme tools");

    const host = makeRuntime();
    const result = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(result.status).toBe("published");
    expect(result.tools).toEqual(["hello"]);
    expect(result.skipped).toEqual([
      { path: "workflows/deferred.ts", reason: "not supported yet" },
    ]);
    const descriptor = await run(host.runtime.getDescriptor("githubTools"));
    expect(descriptor?.description).toBe("Acme tools");
    expect(descriptor?.source).toEqual({
      kind: "github",
      repo: "acme/tools",
      ref: "main",
      upstreamSha: "commit-a",
    });
    await host.close();
  });

  it("reports up-to-date when the upstream commit SHA is unchanged", async () => {
    const github = makeGitHubFetch({
      files: new Map([["tools/hello.ts", toolSource("hello")]]),
      upstreamSha: "same-sha",
    });
    const host = makeRuntime();
    const first = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    const second = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(first.status).toBe("published");
    expect(second).toEqual({
      status: "up-to-date",
      upstreamSha: "same-sha",
      tools: ["hello"],
      skipped: [],
    });
    await host.close();
  });

  it("rejects oversized trees before fetching blobs", async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < PUBLISH_LIMITS.maxFiles + 1; i++) {
      files.set(`tools/t${i}.ts`, toolSource(`t${i}`));
    }
    const github = makeGitHubFetch({ files });
    const exit = await Effect.runPromiseExit(
      fetchGitHubSource({ repo: "acme/tools", fetch: github.fetch }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("exceeding the limit");
    expect(github.blobCalls()).toBe(0);
  });

  it("returns typed failure data for publish errors", async () => {
    const github = makeGitHubFetch({
      files: new Map([
        [
          "tools/bad.ts",
          `import { defineTool } from "executor:app";
import { chunk } from "lodash";
export default defineTool({ description: "bad", input: { type: "object" }, async handler(){ return chunk([1], 1); } });`,
        ],
      ]),
      upstreamSha: "bad-sha",
    });
    const host = makeRuntime();
    const result = await run(
      syncGitHubSource({
        runtime: host.runtime,
        scope: "githubTools",
        repo: "acme/tools",
        fetch: github.fetch,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.upstreamSha).toBe("bad-sha");
    expect(result.errors?.[0]?.stage).toBe("bundle");
    expect(result.errors?.[0]?.message).toContain('bare import "lodash" is not allowed');
    await host.close();
  });
});
