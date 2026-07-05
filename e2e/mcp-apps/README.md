# MCP Apps tests (sunpeak) — executor apps' published UI

Mount and test **executor apps' published UI** (the daily-brief dashboard, served
as a `ui://` MCP-Apps resource) in a **real MCP-Apps host**, headlessly, in CI,
with **no VM and no Claude/ChatGPT account**.

[sunpeak](https://github.com/Sunpeak-AI/sunpeak) locally replicates the Claude
and ChatGPT app runtimes: it connects to an MCP server, calls a UI tool, mounts
the returned `ui://` resource in a sandboxed iframe with the host bridge, and
hands the test a frame-scoped handle to the rendered component. Every test runs
against both host simulations.

## Run

```bash
cd e2e/mcp-apps
npm install
npm test           # boots our self-host MCP server + sunpeak, runs the specs
```

`playwright.config.ts` starts two web servers: our self-host wrapper
(`scripts/start-server.mjs`, under Bun) and sunpeak's inspect backend. The
wrapper boots the REAL self-host app in-process, publishes the daily-brief app,
populates its scope-db `issues` table from a GitHub emulator, and serves `/mcp`
on a fixed loopback port with the Better-Auth bearer injected (so sunpeak needs
no credentials).

A spec is tiny:

```ts
import { test, expect } from "sunpeak/test";
test("dashboard mounts", async ({ inspector }) => {
  const result = await inspector.renderTool("apps_open_ui", { name: "dashboard" });
  await expect(result.app().getByText("Open issues")).toBeVisible();
  await expect(result.app().getByText(/\/app#\d+/)).toBeVisible();
});
```

## How our UI reaches a host

Our published `ui://<scope>/<name>` resource is a COMPLETE, self-booting HTML
document (`text/html;profile=mcp-app`): React, the `executor:ui` runtime
(`useQuery`/`useTool`/`config`), the compiled component, and the current
scope-db rows are all inlined, so it renders under a strict sandbox CSP with no
network. The `apps_open_ui` MCP tool declares `_meta.ui.resourceUri` pointing at
that resource, which is how a real MCP-Apps host (and sunpeak) knows to render
it when the tool runs. See `packages/plugins/apps/src/mcp/ui-shell.ts` (document
builder) and `.../mcp/register.ts` (tool + resource template).

## Notes (vs the earlier render-ui harness)

1. **Use the LATEST sunpeak and DO NOT patch it.** sunpeak now advertises the
   MCP-Apps UI _client_ capability upstream, so widgets mount inline without the
   old `scripts/patch-sunpeak.mjs` (dropped here on purpose).
2. **Extra iframe descent.** Our shell mounts the component directly in the host
   sandbox iframe, so `result.app()` reaches it. If the shell is ever changed to
   nest a further `srcdoc` iframe, add one `.frameLocator("iframe")` descent in
   the spec.

## Scope

sunpeak is a host _simulation_: it covers the protocol contract, the rendered UI,
and tool/theme/display-mode behavior. It does not catch real-host quirks (OAuth,
production CSP). Live SSE-driven refetch INTO the mounted widget is a documented
follow-up (see `APPS_DESIGN.md`); this harness proves mount + first-paint row
rendering.
