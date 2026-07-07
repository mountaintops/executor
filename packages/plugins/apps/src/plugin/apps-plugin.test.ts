import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { IntegrationSlug } from "@executor-js/sdk";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { SourceOriginError, appsPlugin, assertSourceOrigin } from "./apps-plugin";
import { makeSelfHostAppsRuntime } from "./self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver } from "../testing";
import { dailyBriefFileSet } from "../testing/daily-brief";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("appsPlugin custom-tools contract", () => {
  it.effect("detects GitHub repo URLs for console auto-detect", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [appsPlugin()] as const });

      const repo = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo",
      );
      const tree = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/tree/feature/custom-tools",
      );
      const commit = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/commit/abc1234",
      );

      expect(repo).toEqual([
        {
          kind: "apps",
          confidence: "high",
          endpoint: "https://github.com/RhysSullivan/executor-custom-tools-demo",
          name: "Add custom tools from RhysSullivan/executor-custom-tools-demo",
          slug: "executor-custom-tools-demo",
        },
      ]);
      expect(tree[0]?.endpoint).toBe(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/tree/feature/custom-tools",
      );
      expect(commit[0]?.endpoint).toBe(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/commit/abc1234",
      );
    }),
  );

  it.effect("leaves non-repo GitHub URLs unclaimed by custom tools detection", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [appsPlugin()] as const });

      const gist = yield* executor.integrations.detect(
        "https://gist.github.com/RhysSullivan/abc1234",
      );
      const file = yield* executor.integrations.detect(
        "https://github.com/RhysSullivan/executor-custom-tools-demo/blob/main/openapi.json",
      );

      expect(gist).toEqual([]);
      expect(file).toEqual([]);
    }),
  );

  it.effect("rejects publishing through a different source door for a GitHub-managed app", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(assertSourceOrigin("github", "mcp"));

      expect(failure).toBeInstanceOf(SourceOriginError);
      expect(failure.message).toBe("this app is managed by its GitHub repo");
      expect(failure.existingOrigin).toBe("github");
      expect(failure.requestedOrigin).toBe("mcp");
    }),
  );

  it("round-trips custom tool files through publish, resolveTools, and invokeTool", async () => {
    let issueListArgs: unknown;
    const resolver = makeTestResolver(
      {
        github: {
          "issues.listForRepo": (args) => {
            issueListArgs = args[0];
            return [{ number: 7, title: "Renewal diligence" }];
          },
        },
        gmail: {
          "messages.search": () => ({ messages: [] }),
        },
      },
      [
        {
          address: "tools.github.user.github-main",
          integration: "github",
          name: "github-main",
        },
        {
          address: "tools.gmail.user.inbox-main",
          integration: "gmail",
          name: "inbox-main",
        },
      ],
    );
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-plugin-")),
      store: makeInMemoryAppsStore(),
      resolver,
      inMemory: true,
    });
    const runtime = host.runtime;
    const plugin = appsPlugin({ backings: host.backings });
    const appIntegration = IntegrationSlug.make("rhys-tools");
    const appConfig = {
      origin: "github",
      kind: "github",
      repoUrl: "https://github.com/rhys/tools",
      repo: "rhys/tools",
      scope: "rhys",
    };
    const ctx = {
      owner: { tenant: "org" },
      core: {
        integrations: {
          get: (slug: IntegrationSlug) =>
            Effect.succeed(
              String(slug) === String(appIntegration)
                ? {
                    slug: appIntegration,
                    name: "Rhys tools",
                    description: "Rhys tools",
                    kind: "apps",
                    canRemove: true,
                    canRefresh: false,
                    authMethods: [],
                    config: appConfig,
                  }
                : null,
            ),
        },
      },
    };

    await run(runtime.publish({ scope: "rhys", files: dailyBriefFileSet() }));

    const resolved = await run(
      plugin.resolveTools!({
        ctx,
        config: appConfig,
        connection: { name: "main" },
      } as never),
    );
    const syncTool = resolved.tools.find((tool) => String(tool.name) === "issues-sync");
    expect(syncTool).toBeTruthy();
    const persistedInputSchema = syncTool!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(persistedInputSchema.properties.github).toBeUndefined();

    const projected = await run(
      plugin.projectToolSchema!({
        ctx,
        toolRow: {
          name: "issues-sync",
          integration: appIntegration,
          connection: "main",
        },
        inputSchema: syncTool!.inputSchema,
        outputSchema: syncTool!.outputSchema,
      } as never),
    );
    const inputSchema = projected.inputSchema as {
      properties: Record<string, { enum?: string[]; default?: string; description?: string }>;
      required?: string[];
    };
    expect(inputSchema.properties.github.enum).toEqual(["tools.github.user.github-main"]);
    expect(inputSchema.properties.github.default).toBe("tools.github.user.github-main");
    expect(inputSchema.properties.github.description).toBe("Connection to use for github (github)");
    expect(inputSchema.required ?? []).not.toContain("github");

    const output = await run(
      plugin.invokeTool!({
        ctx,
        toolRow: {
          name: "issues-sync",
          integration: appIntegration,
          connection: "main",
        },
        args: {
          github: "tools.github.user.github-main",
          repos: ["acme/tools"],
          since: "2026-01-01T00:00:00Z",
        },
      } as never),
    );

    expect(output).toEqual({
      synced: 1,
      repos: 1,
      issues: [{ repo: "acme/tools", number: 7, title: "Renewal diligence" }],
    });
    expect(issueListArgs).toEqual({
      owner: "acme",
      repo: "tools",
      state: "open",
      since: "2026-01-01T00:00:00Z",
      per_page: 100,
    });
    await host.close();
  });
});
