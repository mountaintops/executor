# Deploying executor-cloud

executor-cloud deploys with an **upload then staged-promotion** flow, not an
immediate 100% cutover. This exists because every full deploy restarts all
Durable Objects, and the MCP session DOs (`McpSessionDOSqlite`) hold live
streaming sessions: a cutover mid-call drops in-flight MCP tool results. Staging
the promotion bounds that blast radius and keeps a mere merge from disrupting
anything.

The mechanics below were validated empirically on a throwaway lab worker
(`executor-cloud-deploy-lab`, see `scripts/deploy-lab/`); the "what happens"
claims are measured, not assumed. The findings are summarized at the end.

## The flow

1. **Merge to main** runs `.github/workflows/deploy.yml`:
   - `migrate` applies database migrations.
   - `upload-cloud` runs `wrangler versions upload`. This creates a new Worker
     **version** but routes **no traffic** to it. No DOs restart; live MCP
     sessions keep running. This is safe to do on every merge.
2. **Promotion is a separate, deliberate step.** Re-run the Deploy workflow via
   **workflow_dispatch** with a `promote_percent` input (1-100). The
   `promote-cloud` job promotes the **latest uploaded** version to that
   percentage of traffic (`scripts/promote-cloud.ts`, which calls
   `wrangler versions deploy`). For a canary, start small (e.g. 10), watch
   telemetry, then re-run at a higher percentage; run 100 for a full cutover.

### Promoting from the CLI (manual, out of band)

From `apps/cloud`, against the generated build config:

```bash
bun run build
# Canary: latest uploaded version at 10%, current-live at 90%.
bun run scripts/promote-cloud.ts --percent 10
# Advance:
bun run scripts/promote-cloud.ts --percent 50
# Full cutover:
bun run scripts/promote-cloud.ts --percent 100
```

The script sorts versions by version number, promotes the newest, and holds the
remainder of a partial promotion on the current-live version.

## Session version-affinity (zone ruleset, MUST be configured manually)

During a gradual rollout the **stateless front worker** and the **session DO**
can run different versions. DOs are natively version-pinned (a DO keeps its
assigned version for the deployment), but the front worker is not: without
affinity, consecutive requests for one MCP session hash to different worker
versions, so a request can hit a worker version that differs from its DO's
version (measured: a v2 front worker talking to a v3 DO).

Cloudflare routes a request to a specific version when the
`Cloudflare-Workers-Version-Key` header is set: the same key value always maps
to the same version for the life of a gradual deployment. We set that key from
the **MCP session id** so every request for one session sticks to one worker
version.

This is a **zone-level request-header-transform rule on `executor.sh`** and
cannot be set from the repo. Create it in the Cloudflare dashboard (Rules ->
Transform Rules -> Modify Request Header, or the Rulesets API, phase
`http_request_late_transform`) that copies the `mcp-session-id` request header
into `Cloudflare-Workers-Version-Key`. The exact rule:

```
# When: /mcp requests that carry a session id.
(http.request.uri.path wildcard "/mcp*" and len(http.request.headers["mcp-session-id"]) > 0)

# Action: Set static / dynamic request header
#   Header name:  Cloudflare-Workers-Version-Key
#   Value (dynamic expression):  http.request.headers["mcp-session-id"][0]
```

Requests without the header (e.g. the initial `initialize` that mints the
session) fall back to normal weighted routing, which is correct: there is no
session to pin yet. Once the client echoes `mcp-session-id`, every subsequent
request for that session is version-pinned to the worker version its DO landed
on.

Validated on the lab worker by sending `Cloudflare-Workers-Version-Key`
directly (12 requests per key across a 4-key set during a two-version gradual
deployment): each distinct key deterministically mapped to exactly one version
across all its requests, while unkeyed requests split across versions per the
weighted split. In production the header-transform rule sets the key from the
session id so clients never send it themselves.

## Durable Object migrations deploy separately

DO class migrations (the `migrations` array in `wrangler.jsonc`: `new_classes`,
`new_sqlite_classes`, renames, deletes) take effect when a version carrying them
is **promoted**, not merely uploaded, and Cloudflare validates a DO delete
against the live binding. Policy:

- Never combine a DO class change with a risky app change in one version you
  intend to canary slowly: a DO migration wants a clean promotion.
- To delete an orphaned DO class, promote a version that still exports it as a
  stub first (nothing binds it), then delete it in a **later** version. This is
  already how `McpSessionDO` (KV) was retired in favour of the SQLite class.

## Rollback

Roll back by promoting the previous-good version to 100%:

```bash
wrangler versions list -c dist/server/wrangler.json    # find the good version id
wrangler versions deploy -c dist/server/wrangler.json <good-version-id>@100% --yes
```

Constraints:

- **Rollback takes effect fast and the session survives.** Measured: promoting
  the previous version back to 100% took effect within seconds (all subsequent
  requests served by the rolled-back version), and a session that existed before
  the rollback still worked afterwards, its `tools/list` returned 200 and its DO
  storage was intact. As with any promotion, a call in flight at the instant of
  the rollback is lost (the DO whose pinned version changes restarts), but the
  session id and its persisted state carry across.
- **Migrations can block a rollback.** A version cannot be promoted if its DO
  migration state is behind the account's applied migrations (you cannot
  "un-create" a DO class by rolling back). If a release included a DO migration,
  rolling back to a pre-migration version may be refused; roll forward with a
  fix instead.

## What the staged flow does and does not fix

Measured on the lab worker:

- **Fixed, merges no longer disrupt anything.** `wrangler versions upload` does
  not restart DOs; a session opened before an upload runs straight through it.
  Measured: an upload fired mid-call (mid a ~30s in-flight tool call) caused
  zero disruption, the call's result marker was delivered normally. Most CI
  runs now upload only.
- **Fixed, staged blast radius.** A gradual promotion only restarts the DOs
  whose sessions land on the newly promoted version at each step, instead of all
  DOs at once.
- **Fixed, no mid-session worker/DO version skew** once the affinity ruleset is
  in place: the front worker matches the session's DO version for the rollout
  window.
- **Not fixed yet, the promotion itself still restarts DOs whose pinned version
  changes.** Promoting a new version to traffic moves those DOs' version and
  restarts them, so an in-flight call at the moment of promotion is still lost
  (same shape as the old cutover, but now scoped to the promoted slice, not
  everyone). Measured: a `versions deploy new@100` fired mid-call ended the
  in-flight stream with no result. Eliminating this needs durable-pause work on
  the DO and is out of scope here.
- **The session outlives a promotion even though the in-flight call does not.**
  Measured across the version swap: the session id stayed valid, the persisted
  event store survived the swap intact, and a reconnect GET replayed the prior
  events across the version boundary (older-version events replayed correctly on
  the newer version). So a client that reconnects recovers its stream, it just
  has to re-issue the one call that was in flight at the instant of promotion.
  This is why promotion is the **only** disruptive moment: uploads are free,
  and even a promotion loses only the single in-flight call, not the session or
  its history.

## The lab worker (`scripts/deploy-lab/`)

`scripts/deploy-lab/` is a self-contained, re-runnable staging worker that
mounts the **real** `McpAgentSessionDOBase` + the patched `agents` transport
with stub auth and a trivial `execute` tool, so the versions / gradual-
deployment / affinity / rollback mechanics can be validated against the real
transport with no production secrets. Deploy it as
`executor-cloud-deploy-lab` (workers_dev only, never routed):

```bash
# from the repo root (bypasses apps/cloud's dist config redirect)
wrangler deploy -c apps/cloud/scripts/deploy-lab/wrangler.jsonc --var LAB_VERSION:v1
```

It exposes `/mcp` (real streamable-HTTP MCP) and `/__lab/version` (echoes the
serving worker version, for observing traffic splits and affinity). Delete it
when done (`wrangler delete -c apps/cloud/scripts/deploy-lab/wrangler.jsonc`).

> **workers.dev caveat (lab only).** The lab is reached over its
> `*.workers.dev` subdomain, which had to be explicitly enabled once (Workers
> dashboard -> the worker -> Settings -> Domains & Routes -> enable the
> `workers.dev` route) before requests resolved; the config's `workers_dev:
true` alone was not sufficient on first deploy. This does **not** apply to
> production executor-cloud, which is served through configured **routes** on
> `executor.sh`, not a workers.dev subdomain.

See `scripts/deploy-lab/README.md` for the full experiment runbook and the
measured results.
