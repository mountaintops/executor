# Executor apps — self-hosted build (design record)

Durable record of the architecture, seam signatures, package layout, key
decisions, verification commands, and known gaps for the executor apps
subsystem built into the self-hosted deployment.

Note: the brief asked for `DESIGN.md`, but the repo already tracks a
design-system doc at `design.md`, and this repo lives on a case-insensitive
filesystem (`DESIGN.md` and `design.md` collide). To avoid clobbering the
design system, this apps architecture record lives at `APPS_DESIGN.md`.

## What this is

User-authored, git-backed, published units — **custom tools**, **durable
workflows**, **UI views**, **skills** — published into a per-scope store and
served/executed by the self-hosted platform. Identity is the file path
(`tools/issues-sync.ts` IS the tool `issues-sync`). Publish is the compiler
(FDI): catalog entries, schedules, ui resources and the skills index are
projections of a versioned descriptor extracted from source at publish.

The subsystem lives in one package, `@executor-js/plugin-apps`, wired into the
self-host app the same way every other plugin is (a source plugin in
`executor.config.ts`, HTTP routes as an extension, MCP tools/resources through
the MCP build hook). Everything substrate-specific sits behind a **seam** with
a substrate-neutral interface and a conformance suite that runs against the
interface, so future Cloudflare backings drop in without touching the
subsystem's logic.

## The five seams

Each seam is a substrate-neutral interface. Self-hosted backings are built now;
cloud backings are future. Everything crossing `ToolSandbox` is serializable
(the cloud version is RPC).

| Seam | Self-hosted backing (built) | Cloud backing (future) |
|---|---|---|
| `ArtifactStore` | bare git repo per scope on disk (git CLI subprocess); `SnapshotId` = commit hash | Cloudflare Artifacts |
| `ScopeDb` | one libSQL/SQLite file per scope + per-table version counters | DO facets |
| `ToolSandbox` | QuickJS kernel (collect + invoke via the `SandboxToolInvoker` bridge) | Worker Loaders |
| `WorkflowRunner` | SQLite event-sourced journal replay runner + in-process scheduler | CF Workflows + dynamic-workflows |
| `LiveChannel` | in-process emitter + SSE | DO/facet socket owner |

See `src/seams/*.ts` for the exact interfaces and `src/seams/*.conformance.ts`
for the suite each backing must pass.

## Decisions (and why)

- **Sandbox = QuickJS** (`packages/kernel/runtime-quickjs`). Its
  `CodeExecutor.execute(code, toolInvoker)` already gives the serializable
  handle bridge: `SandboxToolInvoker.invoke({path, args})` crosses as JSON,
  `tools.<...>()` is a Proxy in the sandbox, `fetch` is disabled, there is a
  deadline interrupt and a memory cap. secure-exec evaluated and rejected
  (pre-1.0, per-arch native sidecar, flat string bridge fighting the Proxy
  pattern); the Deno subprocess kernel is the documented harder-isolation
  escalation behind the same seam. Because QuickJS evaluates a *string*, the
  collect/invoke wrappers own the module shape: the published bundle is a
  self-executing script that either records `define*()` descriptors (collect)
  or calls one handler with injected clients (invoke).
- **Storage via host facades, not new tables.** Executor plugins deliberately
  do not contribute FumaDB tables (`collectTables()` is fixed and
  plugin-independent). App metadata (descriptors, snapshot pointers, schedules,
  workflow journal, ui metadata) lives in `pluginStorage` collections; large
  opaque blobs (compiled bundles, snapshot manifests) live in the `blobs`
  facade, content-addressed by SHA-256.
- **ScopeDb is separate from the executor DB.** App *data* (the `issues` table
  authors read/write) is one libSQL file per scope, independent of the
  executor's own DB. Per-table version counters live alongside it and drive
  `LiveChannel`.
- **Apps are a plugin source.** A published app maps to one executor
  *integration* per scope (`apps`); a *connection* to it makes the published
  tools catalog citizens through `resolveTools`/`invokeTool`, so
  policy/approval/audit/toolkits/tools.list all apply unchanged.
- **No @effect/workflow.** The local runner is a purpose-built SQLite
  event-sourced journal modeled on vercel/workflow's `World` Storage contract
  (append-only events, materialized run/step views, replay-on-resume).

## Package layout

```
packages/plugins/apps/
  src/
    seams/        ArtifactStore, ScopeDb, ToolSandbox, WorkflowRunner, LiveChannel
                  + one <seam>.conformance.ts per seam (runs against the interface)
    backing/      the self-hosted backing for each seam + their *.test.ts wiring
                  (git-artifact-store, libsql-scope-db, quickjs-tool-sandbox,
                   sqlite-workflow-runner, in-process-live-channel,
                   sqlite-apps-store) + the SIGKILL kill test
    pipeline/     discover -> bundle -> collect -> project (publish = the compiler)
    plugin/       runtime (the substrate-neutral core), bindings (connection DI),
                  store, apps-plugin (source: resolveTools/invokeTool),
                  self-host-runtime + self-host (one-call wiring)
    http/         publish + invoke + ui-bundle + SSE + workflow routes (web handler)
    mcp/          publish door, skills list/read, ui:// resources over MCP
    testing/      in-memory store, github REST resolver, daily-brief fixtures,
                  kill-child harness, the e2e proof
```

The subsystem is wired into `apps/host-selfhost/src/apps.ts` and mounted in
`app.ts` (extension route `/api/apps/*` + close hook). `apps.node.test.ts` boots
the real self-host server and drives publish -> ui-bundle -> tool-invoke.

## Seam signatures (the substrate-neutral contracts)

- `ArtifactStore.forScope(scope) -> ScopeArtifactStore { commit(files,msg) ->
  SnapshotMeta; read(id) -> FileSet; readFile; list; latest; log }`. SnapshotId =
  git commit hash.
- `ScopeDb.forScope(scope) -> ScopeDbHandle { sql`...`; exec; tableVersion;
  versions }` + `onWrite(listener)` (write events carry per-table versions).
- `ToolSandbox { collect(bundle) -> CollectResult; invoke(bundle, request,
  HandleBridge) -> InvokeResult }`. `HandleBridge.call({root, path, args}) ->
  Effect<unknown>` is the ONLY thing crossing the boundary — all JSON.
- `WorkflowRunner { start(input, execute, bindings); resume; signal; cancel; get;
  list; listSteps }`. `execute(DurableSteps) -> Promise` is the body; `bindings`
  = `{ runTool, notify }` reach the outside for `step.tool`/`step.notify`.
- `LiveChannel { publish(Invalidation); subscribe(scope, listener) }`.

## Two decisions worth review

1. **Workflow orchestration runs in-process; tool handlers run in the sandbox.**
   The durable body (`step.do`/`step.tool`/`step.sleep`/`step.waitForEvent`) is
   evaluated in-process via a trusted `new Function` shim because `step.do(name,
   () => ...)` closures cannot cross the sandbox boundary (the same reason CF
   runs the orchestrator in a constrained isolate with the journal as an external
   service). The real side-effectful work — every custom tool a `step.tool` calls
   — runs in the QuickJS sandbox with bound clients. The durability guarantee
   (journal + replay, proven by the SIGKILL kill test) is fully real. Flagging
   for review: hardening the orchestrator into the sandbox too (a `step` proxy
   bridged like the injected clients) is the natural follow-up if workflow bodies
   must be as isolated as tool handlers.

2. **The `ClientResolver` seam is where "policy/audit applies".** A tool's
   injected clients route method calls through `ClientResolver.call({integration,
   connection, path, args})`. In the e2e this is a real authenticated HTTP call
   to the emulate GitHub (proven via the emulator's request ledger). In the
   running self-host server the resolver returns a typed NotImplemented for
   external integrations because wiring it to the executor catalog needs
   per-request executor context the boot-time plugin construction does not hold.
   The scope-database path (`db.sql`) is fully live in the running server.
   Flagging for review: the clean fix is a host-provided per-request invoke
   function (executor.execute by address) handed to the resolver.

## Verification gates — exact commands + results

Run from the workspace root
(`usefulsoftwareco/.rifts/executor/apps-build-b`):

- **Typecheck (repo root):** `bun run typecheck` -> 43/43 tasks green.
- **Apps package (conformance + kill + pipeline + integration + e2e):**
  `bun run --filter='@executor-js/plugin-apps' test` -> 11 files, 44 tests pass.
  - ArtifactStore conformance (round-trip, snapshot immutability, log, isolation)
  - ScopeDb conformance (isolation, version bumps, tagged-template sql,
    LiveChannel delivery)
  - ToolSandbox conformance (determinism catches Math.random, network denial,
    timeout kill, handle-bridge round-trip incl. fan-out arrays)
  - WorkflowRunner conformance (memoization, sleep, waitForEvent+signal, retry,
    step.tool journaling) + the SIGKILL kill test (side-effect file written once)
  - publish pipeline (daily-brief -> descriptor; rejects npm imports + bad skill)
  - AppsRuntime end-to-end (publish -> invoke into scope db -> workflow)
  - the package e2e proof (real GitHub emulator: publish MCP, invoke HTTP,
    workflow, ui MCP-Apps HTML document + raw bundle, SSE invalidation, skills MCP)
- **Self-host suite (existing + the new booted wire e2e):**
  `bun run --filter='@executor-js/host-selfhost' test` -> 20 files, 82 tests pass
  (75 original + 7 in the new `apps-wire.node.test.ts`).

The package e2e is the single-command in-package proof:
`bun run --filter='@executor-js/plugin-apps' test -- src/testing/e2e.test.ts`.

### Proof over the wire (Fix 5) — booted host, real MCP client

`apps/host-selfhost/src/apps-wire.node.test.ts` boots the ACTUAL self-host app
(the same composition `serve.ts` uses), connects a REAL MCP client
(`@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`) to the
served `/mcp` endpoint, and drives the whole subsystem over the wire (no
`FakeMcpServer`):

- publish the daily-brief file set over the `apps_publish` MCP door;
- wire the scope into the catalog via the `executor.apps.connect_catalog`
  built-in (registers the `apps` integration + creates the `apps/<scope>`
  connection through the caller's request context); the published `issues-sync`
  tool becomes a searchable catalog citizen (`tools.apps.user.appsdefault.…`);
- invoke it through the catalog path (`execute` sandbox) — the GitHub emulator's
  request ledger proves the upstream call landed and the scope db is written;
- start `morning-sync` (manual) through the `executor.apps.start_workflow`
  built-in — it completes with a journaled `tool:issues-sync` step;
- read the `ui://<scope>/dashboard` resource over MCP (`resources/read`);
- observe the SSE `invalidate` frame over HTTP after a scope-db write;
- list + read the published skill over MCP.

Single command:
`bun run --filter='@executor-js/host-selfhost' test -- src/apps-wire.node.test.ts`.

### Proof of the widget mounting (MCP Apps host simulation)

`e2e/mcp-apps/` is a [sunpeak](https://github.com/Sunpeak-AI/sunpeak) harness
that mounts the published dashboard in a headless replica of the Claude and
ChatGPT MCP-Apps host runtimes (sandboxed iframe + real host bridge, no VM, no
account). `apps/host-selfhost/scripts/mcp-apps-serve.ts` boots the real self-host
in-process, publishes the daily-brief app, populates the scope-db `issues` table
from a GitHub emulator, and serves `/mcp` on a fixed loopback port with the
Better-Auth bearer injected. The spec renders the `apps_open_ui` tool (whose
`_meta.ui.resourceUri` links to the ui resource) and asserts the widget MOUNTS
and RENDERS the scope-db rows (`2 open issues`, `…/app#<n>`) in BOTH host sims.

Single command (isolated from the bun workspace; uses the latest sunpeak with NO
patch script — sunpeak now advertises the MCP-Apps UI client capability
upstream):
```
cd e2e/mcp-apps && npm install && npm test
```

### Shape fixes made to the MCP Apps serving (in scope, Fix 5)

Bringing the serving up to what a real host (per sunpeak) expects surfaced three
shape bugs, now fixed:

1. **ui resource was a fixed URI, not a template.** `registerResource` was
   passed the literal string `ui://<scope>/`, which only matches itself, so
   `resources/read` of `ui://<scope>/<name>` 404'd. Now a real
   `ResourceTemplate("ui://<scope>/{name}")` (mcp/register.ts).
2. **ui resource served raw compiled JS, not a document.** A real MCP-Apps host
   mounts an HTML document, not a CJS blob. `mcp/ui-shell.ts` now wraps the
   compiled bundle into a complete, self-booting `text/html;profile=mcp-app`
   document: React + a minimal `executor:ui` runtime (`useQuery`/`useTool`/
   `config`) + component primitives + the current scope-db rows, all inlined
   (hermetic — renders under a strict sandbox CSP with no network). Served by the
   new `AppsRuntime.getUiDocument`.
3. **no tool linked a host to the ui resource.** MCP-Apps hosts render a view
   when a tool declaring `_meta.ui.resourceUri` runs. Added `apps_open_ui`
   (mcp/register.ts) carrying that extension.

The scope <-> apps-connection mapping was also fixed: the executor normalizes
connection names to camelCase identifiers, so the old `apps/<scope>` form did
not survive create (`apps/default` -> `appsDefault`) and `resolveTools` could not
recover the scope. The mapping is now identifier-native (`apps` + PascalCase
scope), round-tripping cleanly (apps-plugin.ts).

The running-server external-integration routing (previously a documented
NotImplemented gap) is now LIVE: `apps/host-selfhost/src/apps-resolver.ts`
resolves an integration's base URL from its registered record's config, so a
published tool's `github.*` calls dispatch through the caller's connection +
credentials to the real upstream (proven end-to-end against the emulator in the
wire e2e). The per-request resolver is threaded into both the catalog tool-invoke
path AND the workflow `step.tool` path (via `startWorkflow`'s new `resolver`).

## Known gaps (honest list)

- **catalog() open-world proxy**: parsed + recorded in the descriptor; execution
  throws NotImplemented (in scope per the brief).
- **Running-server external-integration routing** (was NotImplemented; now
  LIVE): a published tool's external calls dispatch through the caller's
  connection + credentials to the real upstream, resolved per request from the
  integration record's base URL (apps-resolver.ts). Remaining: the dotted
  method-path -> REST-endpoint mapping is GitHub-style (`repos.listForAuthenticatedUser`
  -> `/user/repos`, `issues.listForRepo` -> `/repos/{owner}/{repo}/issues`), enough
  for the daily-brief fixture and REST-shaped integrations whose method paths
  mirror their URLs; a fully general per-integration operation table (and
  GraphQL/non-REST) fails with a typed BindingError rather than guessing.
- **Live SSE refetch INTO the mounted widget**: the ui document's `useQuery`
  renders the rows the server inlines at read time and re-renders on a host
  `executor:ui/rows` postMessage, and the SSE `invalidate` frame is proven over
  HTTP (wire e2e) — but wiring the SSE stream through the MCP-Apps host bridge so
  the mounted widget auto-refetches on a scope-db write is a follow-up. The
  sunpeak spec proves mount + first-paint row rendering; live update is not yet
  asserted in a host sim.
- **Workflow orchestrator isolation**: in-process (decision 1 above).
- **Scheduler**: schedules are extracted to the descriptor (IaC-visible) and a
  workflow can be started manually or by a caller; a standalone cron daemon that
  auto-fires due schedules is a thin wrapper over `startWorkflow` and is not
  built (the e2e/tests start runs explicitly). `step.sleep` timers are recorded
  but a wake-timer that auto-resumes sleeping runs is likewise a thin follow-up.
- **MCP registration into the shared server** (was "not hooked in"; now LIVE):
  the self-host MCP seams take an `onServer` hook (apps/host-selfhost/src/mcp),
  and `app.ts` registers the apps MCP surface (publish door, skills, ui://
  resources, `apps_open_ui`) on every per-session MCP server. The wire e2e drives
  all of it through a real MCP client over the served `/mcp` endpoint.
- **Effect-lint suggestions**: a handful of `preferSchemaOverJson` /
  `unnecessaryFailYieldableError` suggestions and `globalErrorInEffectFailure`
  warnings remain (non-fatal; the tsconfig plugin excludes them from the tsc exit
  code). Boundary `try/catch` in web handlers / subprocess callbacks would want
  targeted `oxlint-disable` comments before a lint gate.
