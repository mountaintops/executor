import { describe, expect, it, vi } from "@effect/vitest";

import appsClientPlugin, {
  CUSTOM_TOOLS_LABEL,
  CUSTOM_TOOLS_PLUGIN_KEY,
  appsIntegrationPlugin,
  formatSyncErrors,
  listCustomToolSources,
  syncCustomToolSource,
  syncStatusLabel,
  validateGitHubRepo,
} from "@executor-js/plugin-apps/client";

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("custom tools console client", () => {
  it("registers the manual Custom tools tile", () => {
    const manualTiles = [appsIntegrationPlugin].map((plugin) => ({
      href: `/integrations/add/${plugin.key}`,
      label: plugin.label,
    }));

    expect(appsClientPlugin.id).toBe(CUSTOM_TOOLS_PLUGIN_KEY);
    expect(appsClientPlugin.integrationPlugin?.label).toBe(CUSTOM_TOOLS_LABEL);
    expect(manualTiles).toContainEqual({
      href: "/integrations/add/apps",
      label: "Custom tools",
    });
  });

  it("validates the GitHub repo shape", () => {
    expect(validateGitHubRepo("UsefulSoftwareCo/executor")).toBeNull();
    expect(validateGitHubRepo("UsefulSoftwareCo")).toBe(
      "Use owner/name, for example UsefulSoftwareCo/executor.",
    );
    expect(validateGitHubRepo("")).toBe("Enter a GitHub repo.");
  });

  it("surfaces successful sync and source detail data", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sync")) {
        return jsonResponse({
          status: "published",
          snapshotId: "snap1",
          upstreamSha: "abc123",
          tools: ["repo-summary", "stale-issues"],
          skipped: [],
        });
      }
      return jsonResponse({
        sources: [
          {
            scope: "github:RhysSullivan/executor-custom-tools-demo",
            repo: "RhysSullivan/executor-custom-tools-demo",
            ref: "main",
            connection: "tools.github.user.demo",
            upstreamSha: "abc123",
            snapshotId: "snap1",
            publishedAt: "2026-07-06T12:00:00.000Z",
            tools: ["repo-summary", "stale-issues"],
            skipped: [],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const syncResult = await syncCustomToolSource(
      {
        repo: "RhysSullivan/executor-custom-tools-demo",
        connection: "tools.github.user.demo",
      },
      fetchImpl,
    );
    const listed = await listCustomToolSources(fetchImpl);

    expect(syncStatusLabel(syncResult)).toBe("Published 2 tools.");
    expect(syncResult.tools).toEqual(["repo-summary", "stale-issues"]);
    expect(listed.sources[0]?.tools).toEqual(["repo-summary", "stale-issues"]);
  });

  it("renders failed sync errors readably", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "failed",
        tools: [],
        skipped: [],
        errors: [
          {
            stage: "collect",
            message: "schema library not supported for schema export",
            diagnostics: [{ path: "tools/x.ts", message: "vendor: nope" }],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await syncCustomToolSource(
      {
        repo: "RhysSullivan/executor-custom-tools-demo",
        connection: "tools.github.user.demo",
      },
      fetchImpl,
    );

    expect(syncStatusLabel(result)).toBe("Sync failed.");
    expect(formatSyncErrors(result)).toEqual([
      "collect: schema library not supported for schema export (tools/x.ts: vendor: nope)",
    ]);
  });

  it("shows the up-to-date sync state", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "up-to-date",
        upstreamSha: "abc123",
        tools: ["repo-summary"],
        skipped: [],
      }),
    ) as unknown as typeof fetch;

    const result = await syncCustomToolSource(
      {
        repo: "RhysSullivan/executor-custom-tools-demo",
        connection: "tools.github.user.demo",
      },
      fetchImpl,
    );

    expect(syncStatusLabel(result)).toBe("Already up to date.");
  });
});
