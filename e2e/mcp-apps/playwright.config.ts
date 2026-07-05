import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "sunpeak/test/config";

// sunpeak runs `sunpeak inspect` (a real MCP-Apps host simulation that mounts
// ui:// resources in a sandboxed iframe) as its Playwright web server, connects
// it to the MCP server below, and gives each spec a frame-scoped handle to the
// rendered app. Every spec runs against both the Claude and ChatGPT host
// simulations.
//
// We point sunpeak at OUR self-host over HTTP. `scripts/start-server.mjs` boots
// the real self-host app in-process, publishes the daily-brief app + populates
// its scope-db `issues` table, and serves `/mcp` on a fixed loopback port with
// the Better-Auth bearer injected (so sunpeak needs no credentials). We append
// that wrapper as a SECOND Playwright webServer (health-gated), alongside
// sunpeak's inspect backend.
//
// IMPORTANT (vs the older render-ui harness): use the LATEST sunpeak and DO NOT
// patch it. sunpeak now advertises the MCP-Apps UI *client* capability upstream,
// so widgets mount inline without the old scripts/patch-sunpeak.mjs.

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const hostDir = resolve(repo, "apps/host-selfhost");

const PORT = process.env.MCP_APPS_PORT ?? "8791";

const base = defineConfig({
  testDir: "tests",
  hosts: ["claude", "chatgpt"],
  server: { url: `http://127.0.0.1:${PORT}/mcp` },
  timeout: 120_000,
});

// Our self-host wrapper server, started before the specs and torn down after.
const ourServer = {
  // The seeding server lives under apps/host-selfhost so its imports (emulate,
  // MCP SDK, workspace source) resolve through that package's node_modules.
  command: `bun ${resolve(hostDir, "scripts/mcp-apps-serve.ts")}`,
  cwd: hostDir,
  url: `http://127.0.0.1:${PORT}/health`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: { PORT },
};

const baseWebServers = Array.isArray(base.webServer)
  ? base.webServer
  : base.webServer
    ? [base.webServer]
    : [];

export default {
  ...base,
  // Start our MCP server first, then sunpeak's inspect backend.
  webServer: [ourServer, ...baseWebServers],
};
