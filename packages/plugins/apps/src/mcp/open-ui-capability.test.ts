import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";
import { registerAppsMcp, MCP_APPS_UI_CAPABILITY_KEY, type McpServerLike } from "./register";
import { UI_APP_MIME } from "./ui-shell";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ---------------------------------------------------------------------------
// Finding 10 regression: `apps_open_ui` must check the client's MCP-Apps UI
// capability. A capable client gets a resource link (`_meta.ui.resourceUri`); a
// non-capable client (terminal) gets a fallback URL + a structured status, and
// NO `_meta.ui` (never overpromising a widget it can't render).
// ---------------------------------------------------------------------------

interface Registered {
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

// A fake McpServer capturing tool registrations and advertising a chosen client
// capability.
const makeFakeServer = (
  clientCaps: { extensions?: Record<string, unknown> } | undefined,
): { server: McpServerLike; tools: Map<string, Registered> } => {
  const tools = new Map<string, Registered>();
  const server: McpServerLike = {
    registerTool: (name, _config, handler) => {
      tools.set(name, { handler });
      return undefined;
    },
    registerResource: () => undefined,
    server: { getClientCapabilities: () => clientCaps },
  };
  return { server, tools };
};

const makeRuntime = async () => {
  const store = makeInMemoryAppsStore();
  const resolver = makeTestResolver({
    github: {
      "repos.listForAuthenticatedUser": () => [{ full_name: "acme/app" }],
      "issues.listForRepo": () => [],
    },
  });
  const host = makeSelfHostAppsRuntime({
    dataDir: mkdtempSync(join(tmpdir(), "apps-openui-")),
    store,
    resolver,
    inMemory: true,
  });
  await run(host.runtime.publish({ scope: "default", files: dailyBriefFileSet() }));
  return host;
};

describe("apps_open_ui capability check (Fix 10)", () => {
  it("returns a resource link when the client supports MCP-Apps UI", async () => {
    const host = await makeRuntime();
    const { server, tools } = makeFakeServer({
      extensions: { [MCP_APPS_UI_CAPABILITY_KEY]: { mimeTypes: [UI_APP_MIME] } },
    });
    registerAppsMcp(server, {
      runtime: host.runtime,
      scope: "default",
      uiDocumentUrl: (s, n) => `http://host/api/apps/${s}/ui/${n}?document=html`,
    });

    const res = (await tools.get("apps_open_ui")!.handler({})) as {
      _meta?: { ui?: { resourceUri?: string } };
      structuredContent?: { status?: string };
    };
    // Capable client: resource link + _meta.ui present.
    expect(res._meta?.ui?.resourceUri).toBe("ui://default/dashboard");
    expect(res.structuredContent?.status).toBe("ui");
    await host.close();
  }, 60_000);

  it("returns a fallback URL and NO _meta.ui when the client cannot render UI", async () => {
    const host = await makeRuntime();
    // No UI capability advertised.
    const { server, tools } = makeFakeServer({ extensions: {} });
    registerAppsMcp(server, {
      runtime: host.runtime,
      scope: "default",
      uiDocumentUrl: (s, n) => `http://host/api/apps/${s}/ui/${n}?document=html`,
    });

    const res = (await tools.get("apps_open_ui")!.handler({})) as {
      _meta?: { ui?: unknown };
      structuredContent?: { status?: string; url?: string };
    };
    // Non-capable client: fallback URL, structured status, and NO _meta.ui.
    expect(res._meta).toBeUndefined();
    expect(res.structuredContent?.status).toBe("fallback_url");
    expect(res.structuredContent?.url).toBe(
      "http://host/api/apps/default/ui/dashboard?document=html",
    );
    await host.close();
  }, 60_000);

  it("returns fallback_unavailable when non-capable and no URL is configured", async () => {
    const host = await makeRuntime();
    const { server, tools } = makeFakeServer(undefined);
    registerAppsMcp(server, { runtime: host.runtime, scope: "default" });

    const res = (await tools.get("apps_open_ui")!.handler({})) as {
      isError?: boolean;
      structuredContent?: { status?: string };
    };
    expect(res.structuredContent?.status).toBe("fallback_unavailable");
    expect(res.isError).toBe(true);
    await host.close();
  }, 60_000);
});
