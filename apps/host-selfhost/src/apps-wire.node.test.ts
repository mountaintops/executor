import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createEmulator } from "@executor-js/emulate";

import { dailyBriefFileSet } from "@executor-js/plugin-apps/testing";

import { mintInviteCode } from "./testing/mint-invite";

// ===========================================================================
// THE BOOTED-HOST WIRE E2E (Fix 5): prove the apps subsystem over real HTTP +
// a real MCP client, against the ACTUAL self-host app (the same composition
// serve.ts uses), bound to an ephemeral socket.
//
// One runnable command:
//   bun run --filter='@executor-js/host-selfhost' test -- src/apps-wire.node.test.ts
//
// The chain, all over the wire (nothing faked, no FakeMcpServer):
//   1. boot makeSelfHostApiHandler on an ephemeral Bun.serve port
//   2. stand up a real-shaped GitHub via @executor-js/emulate; seed a repo+issues
//   3. sign up (Better Auth) -> bearer token; register the emulator as the
//      `github` integration and create a connection to it (its minted token)
//   4. connect a REAL MCP Client over StreamableHTTP to /mcp
//   5. publish daily-brief over the `apps_publish` MCP door
//   6. tools/list over MCP shows the published tool AS A CATALOG TOOL
//   7. invoke it through the catalog path; the emulator's ledger proves the
//      upstream GitHub call landed
//   8. start the workflow (manual) over HTTP; see it complete with a journal
//   9. read the ui:// resource over MCP (resources/read)
//  10. make a scope-db write; observe the SSE invalidation frame over HTTP
//  11. list + read the published skill over MCP
// ===========================================================================

// Better Auth needs a secret + a bootstrap admin before the app graph imports.
const dataDir = mkdtempSync(join(tmpdir(), "eh-apps-wire-"));
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = "apps-wire-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@apps-wire.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";
// The apps ClientResolver dials the emulator over loopback; allow it.
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

const SCOPE = "default";
const GITHUB_INTEGRATION = "github";
const GITHUB_CONNECTION = "github-emu";

type LocalEmulator = Awaited<ReturnType<typeof createEmulator>>;

describe("Executor apps wire e2e (booted self-host, real MCP client + GitHub emulator)", () => {
  let handler!: (request: Request) => Promise<Response>;
  let dispose: () => Promise<void> = async () => {};
  let github: LocalEmulator;
  // The booted app is an in-process web handler; the "wire" is a real MCP client
  // + real JSON-RPC/SSE framing over a fetch bound to it (vitest runs under Node,
  // so there is no ambient Bun.serve to bind an ephemeral socket to). `origin` is
  // the URL the transport dials; the injected fetch routes it to the handler.
  const origin = "http://apps-wire.internal";
  let token = "";
  let owner = "";

  // A JSON fetch that carries the bearer, aimed at the booted handler.
  const api = (path: string, init?: RequestInit) =>
    handler(
      new Request(`${origin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      }),
    );

  // Fetch shim the MCP StreamableHTTP transport uses: forward WHATWG fetch calls
  // straight into the booted handler.
  const wireFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };

  let client: Client;

  beforeAll(async () => {
    // --- real-shaped GitHub (emulate) + seed a repo with two issues ---------
    github = await createEmulator({ service: "github" });
    const cred = (await github.credentials.mint({
      type: "api-key",
    })) as unknown as {
      token: string;
      login: string;
    };
    const ghToken = cred.token;
    const ghHeaders = {
      authorization: `Bearer ${ghToken}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    };
    const repoRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ name: "app" }),
    });
    const repo = (await repoRes.json()) as { owner: { login: string } };
    owner = repo.owner.login;
    for (const title of ["Fresh bug", "Second bug"]) {
      await fetch(`${github.url}/repos/${owner}/app/issues`, {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({ title, labels: ["bug"] }),
      });
    }

    // --- boot the REAL self-host app (the composition serve.ts uses) --------
    const { makeSelfHostApiHandler } = await import("./app");
    const app = await makeSelfHostApiHandler();
    handler = app.handler;
    dispose = app.dispose;

    // --- sign up -> bearer token --------------------------------------------
    const inviteCode = await mintInviteCode(handler);
    const su = await handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "u@apps-wire.test",
          password: "password-12345678",
          name: "U",
          inviteCode,
        }),
      }),
    );
    token = su.headers.get("set-auth-token") ?? "";
    expect(token).not.toBe("");

    // --- register the emulator as the `github` integration + a connection ----
    // An OpenAPI-shaped integration whose baseUrl points at the loopback
    // emulator: the apps ClientResolver reads that base URL from the integration
    // record and dispatches the published tool's github.* calls there. A minimal
    // spec is enough; the resolver builds REST paths itself (it doesn't drive the
    // spec's operations), so the integration exists only to carry the base URL +
    // hold the connection's credential.
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "GitHub (emulated)", version: "1.0.0" },
      servers: [{ url: github.url }],
      paths: {
        "/user/repos": {
          get: {
            operationId: "listRepos",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const addSpec = await api("/api/openapi/specs", {
      method: "POST",
      body: JSON.stringify({
        spec: { kind: "blob", value: spec },
        slug: GITHUB_INTEGRATION,
        baseUrl: github.url,
      }),
    });
    expect(addSpec.status).toBe(200);

    const conn = await api("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        owner: "user",
        name: GITHUB_CONNECTION,
        integration: GITHUB_INTEGRATION,
        template: "bearer",
        value: ghToken,
      }),
    });
    expect(conn.status).toBe(200);

    // --- connect a REAL MCP client over StreamableHTTP to /mcp --------------
    client = new Client({ name: "apps-wire-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: wireFetch as unknown as typeof globalThis.fetch,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
  }, 90_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await dispose();
    await github?.close();
  });

  it("publishes the daily-brief set over the MCP publish door", async () => {
    const result = (await client.callTool({
      name: "apps_publish",
      arguments: { files: Object.fromEntries(dailyBriefFileSet()) },
    })) as {
      structuredContent?: {
        tools?: string[];
        workflows?: string[];
        ui?: string[];
        skills?: string[];
      };
    };
    const sc = result.structuredContent!;
    expect((sc.tools ?? []).sort()).toEqual(["issues-sync", "search-all-mail"]);
    expect(sc.workflows).toEqual(["morning-sync"]);
    expect(sc.ui).toEqual(["dashboard"]);
    expect(sc.skills).toEqual(["issues-brief"]);
  });

  it("wires the published app into the catalog; the tool becomes a catalog citizen", async () => {
    // Wire the scope into the catalog through the REAL request path: the built-in
    // `executor.apps.connect_catalog` tool registers the `apps` integration and
    // creates the apps/<scope> connection for the caller. Invoked over MCP via
    // the `execute` sandbox, exactly as an agent would.
    const connect = (await client.callTool({
      name: "execute",
      arguments: {
        code: "export default await tools.executor.apps.connect_catalog({});",
      },
    })) as { isError?: boolean; structuredContent?: { status?: string } };
    expect(connect.isError ?? false).toBe(false);
    expect(connect.structuredContent?.status).toBe("completed");

    // The published tool is now discoverable as a catalog tool through the same
    // `tools.search` an agent uses (executor exposes catalog tools inside the
    // `execute` sandbox, not as flat MCP tools — `execute` IS the catalog door).
    const search = (await client.callTool({
      name: "execute",
      arguments: {
        code: 'export default (await tools.search({ query: "sync github issues into the scope table", limit: 30 })).items.map((m) => m.path)',
      },
    })) as { structuredContent?: { result?: string[] } };
    const paths = search.structuredContent?.result ?? [];
    // Addressed as tools.apps.<owner>.<connection>.<tool> — a real catalog citizen.
    expect(paths.some((p) => p.includes("apps.") && p.includes("issues-sync"))).toBe(true);
  });

  it("invokes the published tool through the catalog path; the ledger proves the upstream GitHub call landed", async () => {
    const before = (await github.ledger.list()).length;

    // Invoke via the MCP `execute` sandbox, addressing the published tool through
    // the catalog: tools.apps.<owner>.<connection>.issues-sync(...) routes through
    // resolveTools/invokeTool -> the sandbox -> the per-request ClientResolver ->
    // the GitHub emulator, then writes the scope db.
    const call = (await client.callTool({
      name: "execute",
      arguments: {
        code: `export default await tools.apps.user.appsdefault['issues-sync']({ repos: ["${owner}/app"] });`,
      },
    })) as {
      isError?: boolean;
      structuredContent?: {
        status?: string;
        result?: { ok?: boolean; data?: { synced?: number } };
      };
    };

    expect(call.isError ?? false).toBe(false);
    expect(call.structuredContent?.status).toBe("completed");
    // The execute sandbox wraps a tool result as { ok, data }.
    expect(call.structuredContent?.result?.data?.synced).toBe(2);

    // The emulator's request ledger proves the tool really called GitHub.
    const ledger = await github.ledger.list();
    expect(ledger.length).toBeGreaterThan(before);
    expect(
      ledger.some(
        (e) =>
          String(e.operationId ?? "")
            .toLowerCase()
            .includes("issue") ||
          String((e as { path?: string }).path ?? "")
            .toLowerCase()
            .includes("issues"),
      ),
    ).toBe(true);
  });

  it("starts the workflow (manual) and sees it complete with a journal", async () => {
    // Start the workflow through the REAL request path (the `start_workflow`
    // built-in over the MCP execute sandbox), so its `step.tool` external call
    // reaches the emulator through the caller's connection + per-request resolver.
    const started = (await client.callTool({
      name: "execute",
      arguments: {
        code:
          "export default await tools.executor.apps.start_workflow(" +
          '{ workflow: "morning-sync", runId: "wire-morning" });',
      },
    })) as {
      isError?: boolean;
      structuredContent?: {
        status?: string;
        result?: { data?: { status?: string } };
      };
    };
    expect(started.isError ?? false).toBe(false);
    expect(started.structuredContent?.result?.data?.status).toBe("completed");

    const hist = await api(`/api/apps/${SCOPE}/workflows/runs/wire-morning`, {
      method: "GET",
    });
    const steps = ((await hist.json()) as { steps: { name: string; status: string }[] }).steps;
    expect(steps.some((s) => s.name === "tool:issues-sync" && s.status === "completed")).toBe(true);
  });

  it("reads the ui:// resource over MCP (resources/read)", async () => {
    const read = await client.readResource({ uri: `ui://${SCOPE}/dashboard` });
    const first = read.contents[0] as {
      mimeType?: string;
      text?: string;
      _meta?: { ui?: { title?: string } };
    };
    expect(first.mimeType).toContain("mcp");
    expect(first.text).toContain("issues");
    expect(first._meta?.ui?.title).toBe("GitHub Issues");
  });

  it("delivers an SSE invalidation frame over HTTP after a scope-db write", async () => {
    const res = await api(`/api/apps/${SCOPE}/live`, { method: "GET" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("event: ready");

    // Re-invoke issues-sync via HTTP to write the scope db (a fresh write bumps
    // the version and fires the invalidation).
    await api(`/api/apps/${SCOPE}/tools/issues-sync`, {
      method: "POST",
      body: JSON.stringify({
        args: { repos: [`${owner}/app`] },
        bindings: { github: { kind: "single", connection: GITHUB_CONNECTION } },
      }),
    });

    const invalidation = await Promise.race([
      (async () => {
        // Drain frames until we see an invalidate (there may be keepalives).
        for (let i = 0; i < 10; i++) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const text = decoder.decode(chunk.value);
          if (text.includes("event: invalidate")) return text;
        }
        return "";
      })(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 8000)),
    ]);
    expect(invalidation).toContain("event: invalidate");
    expect(invalidation).toContain('"table":"issues"');
    await reader.cancel();
  });

  it("lists and reads the published skill over MCP", async () => {
    const listed = (await client.callTool({
      name: "apps_list_skills",
      arguments: {},
    })) as { structuredContent?: { skills?: { name: string }[] } };
    expect((listed.structuredContent?.skills ?? []).map((s) => s.name)).toEqual(["issues-brief"]);

    const readSkill = (await client.callTool({
      name: "apps_read_skill",
      arguments: { name: "issues-brief" },
    })) as { content?: { text: string }[] };
    expect(readSkill.content?.[0]?.text).toContain("GitHub issues brief");
  });
});
