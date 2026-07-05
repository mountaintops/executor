// Boot the REAL self-host app in-process, seed a published daily-brief app with
// scope-db rows, then serve its `/mcp` endpoint on a fixed loopback port for the
// sunpeak host simulation (e2e/mcp-apps) to connect to.
//
// The self-host MCP endpoint is Better-Auth-gated. Rather than teach sunpeak the
// auth dance, this wrapper owns auth: it signs up once, holds the bearer, and
// injects it on every forwarded request. sunpeak connects to `/mcp` with no
// credentials; the wrapper adds the Authorization header.
//
// Lives here (under apps/host-selfhost) so its imports resolve through this
// package's node_modules under Bun. Launched by e2e/mcp-apps/playwright.config.ts.
//
// Env in: PORT (wrapper port, default 8791). Health: GET /health -> 200 "ok".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmulator } from "@executor-js/emulate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dailyBriefFileSet } from "@executor-js/plugin-apps/testing";

import { mintInviteCode } from "../src/testing/mint-invite";

const PORT = Number(process.env.PORT ?? "8791");
const origin = "http://mcp-apps.internal";
const log = (...args: unknown[]) => console.log("[mcp-apps-server]", ...args);

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-mcpapps-"));
process.env.BETTER_AUTH_SECRET = "mcp-apps-secret-0123456789-abcdefghij-klmnop";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@mcp-apps.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

// --- real-shaped GitHub emulator + a seeded repo with issues ----------------
const github = await createEmulator({ service: "github" });
const cred = (await github.credentials.mint({
  type: "api-key",
})) as unknown as { token: string };
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
const owner = ((await repoRes.json()) as { owner: { login: string } }).owner.login;
for (const title of ["Fresh bug", "Second bug"]) {
  await fetch(`${github.url}/repos/${owner}/app/issues`, {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({ title, labels: ["bug"] }),
  });
}
log("emulator ready", github.url, "owner", owner);

// --- boot the real self-host handler ---------------------------------------
const { makeSelfHostApiHandler } = await import("../src/app");
const app = await makeSelfHostApiHandler();
const handler = app.handler;

// --- sign up -> bearer token ------------------------------------------------
const inviteCode = await mintInviteCode(handler);
const su = await handler(
  new Request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "u@mcp-apps.test",
      password: "password-12345678",
      name: "U",
      inviteCode,
    }),
  }),
);
const token = su.headers.get("set-auth-token");
if (!token) throw new Error("sign-up produced no token");

const api = (path: string, init: RequestInit = {}) =>
  handler(
    new Request(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
  );

// --- register the emulator as `github`, plus a connection to it -------------
const spec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "GitHub (emulated)", version: "1.0.0" },
  servers: [{ url: github.url }],
  paths: {
    "/user/repos": {
      get: {
        operationId: "listRepos",
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
await api("/api/openapi/specs", {
  method: "POST",
  body: JSON.stringify({
    spec: { kind: "blob", value: spec },
    slug: "github",
    baseUrl: github.url,
  }),
});
await api("/api/connections", {
  method: "POST",
  body: JSON.stringify({
    owner: "user",
    name: "github-emu",
    integration: "github",
    template: "bearer",
    value: ghToken,
  }),
});

// --- connect a real MCP client to publish + populate rows -------------------
const wireFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  handler(input instanceof Request ? input : new Request(input, init));
const client = new Client({ name: "mcp-apps-setup", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: wireFetch as unknown as typeof globalThis.fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
await client.callTool({
  name: "apps_publish",
  arguments: { files: Object.fromEntries(dailyBriefFileSet()) },
});
await client.callTool({
  name: "execute",
  arguments: {
    code: "export default await tools.executor.apps.connect_catalog({});",
  },
});
await client.callTool({
  name: "execute",
  arguments: {
    code: `export default await tools.apps.user.appsdefault['issues-sync']({ repos: ["${owner}/app"] });`,
  },
});
await client.close();
log("published daily-brief + populated issues");

// --- serve a wrapper that injects the bearer for sunpeak --------------------
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return handler(new Request(request, { headers }));
  },
});
log(`serving /mcp for sunpeak at http://127.0.0.1:${server.port}/mcp`);

const shutdown = async () => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  try {
    await app.dispose();
  } catch {
    /* ignore */
  }
  try {
    await github.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
