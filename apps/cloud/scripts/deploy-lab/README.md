# executor-cloud-deploy-lab

A throwaway staging worker for validating the executor-cloud
**upload -> staged-promotion** deploy mechanics against real Cloudflare
deployment machinery (versions, gradual deployments, version affinity, rollback)
and the patched `agents` worker<->DO MCP bridge. It mounts the **real** shared
MCP session Durable Object base (`McpAgentSessionDOBase`) with the **real**
patched transport (`patches/agents@0.17.3.patch`), and stubs only the heavy
cloud seams (Postgres/Hyperdrive, WorkOS, Autumn, Sentry/OTEL) so it boots with
no production secrets. See `worker.ts` for the stubs.

**Never point this at production.** `workers_dev` only, no routes, no custom
domains, no crons. It is safe to `wrangler delete` at any time.

The narrative conclusions from these experiments live in
[`../../DEPLOY.md`](../../DEPLOY.md); this file is the runbook that produced them.

## Deploy / redeploy

Deploy from the repo root so wrangler picks up this config directly (bypassing
`apps/cloud`'s dist redirect). Each version is uploaded with a distinct
`LAB_VERSION` var so every response echoes which worker version served it:

```bash
# Upload a version WITHOUT routing traffic (returns a version id):
wrangler versions upload -c apps/cloud/scripts/deploy-lab/wrangler.jsonc --var LAB_VERSION:v6
wrangler versions upload -c apps/cloud/scripts/deploy-lab/wrangler.jsonc --var LAB_VERSION:v7

# Promote / split traffic:
wrangler versions deploy -c apps/cloud/scripts/deploy-lab/wrangler.jsonc <v6-id>@90% <v7-id>@10% --yes
```

> **workers.dev must be enabled once.** `workers_dev: true` in the config was
> not enough on first deploy: the `*.workers.dev` route had to be turned on
> manually (Workers dashboard -> the worker -> Settings -> Domains & Routes ->
> enable workers.dev) before requests resolved. Production is served through
> `executor.sh` routes, so this caveat is lab-only.

## Endpoints

- `POST/GET/DELETE /mcp`: the real streamable-HTTP MCP surface (session create,
  in-flight `tools/call`, POST-stream disconnect + GET replay). The single tool
  `execute` sleeps `delayMs` then echoes `{ marker, servedByVersion }`, enough
  to hold a ~30-60s call open across a mid-call deploy.
- `GET /__lab/version`: echoes `{ servedByVersion, receivedVersionKey }` and an
  `x-lab-version` header, for observing which worker version served a request
  and whether an affinity key was received.

## Experiment runbook and measured results

All results below were measured against real Cloudflare deployments of this
worker (2026-07-07).

- **Exp3a, no affinity key.** 30 fresh connections over a 10/90 two-version
  split: 28 hit v6, 2 hit v7. Confirms per-request (weighted) routing, a
  stateless worker with no key does not stick to one version.
- **Exp3b, with `Cloudflare-Workers-Version-Key`.** 12 requests per key across a
  4-key set (alpha/bravo/charlie/delta) during the same split: each key mapped
  to exactly one version for all 12 of its requests (alpha/bravo/delta -> v6,
  charlie -> v7), and keys distributed across both versions. **Perfect per-key
  stickiness**, this is the affinity mechanism DEPLOY.md's zone rule relies on.
- **Exp3c, DO pinning.** One MCP session's DO answered on v6 for every request
  including while the stateless front-worker hops varied version. DOs are
  natively version-pinned.
- **Exp4, rollback.** `versions deploy old@100` took effect within seconds
  (10/10 subsequent requests on v6). A session that predated the rollback still
  worked (`tools/list` -> 200) and its DO storage was intact.
- **Exp5, upload mid-call.** `versions upload` fired during a ~30s in-flight
  call caused **zero disruption**, the call completed and its marker was
  delivered (`EXP5_UPLOAD_SAFE`). Uploads are free.
- **Exp5b, promotion mid-call.** `versions deploy new@100` fired during a ~30s
  in-flight call **killed the in-flight execution** (client saw the stream end
  with no result, expected until durable-execution work lands). **But** the
  session survived, the persisted event store survived the version swap, and a
  reconnect GET replayed the prior events across the version boundary.

**Conclusion.** The upload/promote split plus session affinity works as
documented. Promotion is the only disruptive moment, and even then it loses only
the single in-flight call, not the session or its replayable history. The replay
machinery is version-swap-safe.

## Cleanup

```bash
wrangler delete -c apps/cloud/scripts/deploy-lab/wrangler.jsonc
```
