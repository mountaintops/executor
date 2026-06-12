---
name: emulate
description: Use the @executor-js/emulate service emulators (GitHub, Google, Stripe, Resend, WorkOS, …) to test integrations for real — full OpenAPI specs, working OAuth flows, mintable credentials, and a request ledger for assertions. Use when a test or demo needs a real-shaped upstream API, an OAuth/OIDC provider, a spec to feed addSpec, or proof that a request actually landed.
---

# Emulate: production-fidelity service emulators

`@executor-js/emulate` (our fork of Vercel Labs' emulate, developed in
`vendor/emulate` but ALWAYS consumed as the published npm package — never
import from `vendor/`) provides stateful, wire-level emulators for 16
services: `github vercel google okta microsoft spotify slack apple aws
resend stripe mongoatlas clerk x workos autumn`. These are not mocks: real
SDKs and real product code run against them unmodified — the cloud e2e
target points the actual WorkOS SDK (sealed sessions, JWKS, hosted AuthKit
login) and Autumn billing at emulators and exercises the product's real
auth code.

## Two ways to get one — both give the same typed handle

Never hand-roll `fetch` against `/_emulate/*`: every handle carries the
typed control-plane client (`credentials.mint`, `ledger.list/clear`, `seed`,
`reset`, `manifest`, `specs`, `coverage`, `state`, `openapiUrl`), with
responses typed as `LedgerEntry`, `IssuedCredential`, `ServiceManifest`, …
and failures thrown as `EmulatorControlError`.

**Local, programmatic** (what `e2e/setup/cloud.globalsetup.ts` does):

```ts
import { createEmulator } from "@executor-js/emulate";
const github = await createEmulator({ service: "github", port: 4501 });
// github.url, await github.close() — plus the full typed control plane:
const key = await github.credentials.mint({ type: "bearer-token" });
const calls = await github.ledger.list(); // LedgerEntry[]
```

`baseUrl` sets the _advertised_ origin (redirects, form actions, spec
`servers`) when a proxy fronts the emulator — the bind stays on `port`.

**Attach to a running instance** — another process or a hosted one:

```ts
import { connectEmulator, EmulatorClient } from "@executor-js/emulate";
// validates via the manifest that the target IS the service you expect:
const resend = await connectEmulator({ baseUrl: "https://resend.emulators.dev", service: "resend" });
// or zero-I/O construction when you don't want a connect round-trip:
const client = new EmulatorClient("https://resend.emulators.dev");
```

Hosted instances run on Cloudflare with Durable Object state, no setup:

```
https://<service>.emulators.dev                 # service host
https://<service>.<instance>.emulators.dev      # your own stateful instance
GET https://emulators.dev/_emulate/services     # machine-readable catalog
```

Create a private instance with `POST /_emulate/instances` on the service
host. The e2e `connect-handoff` scenario uses `https://resend.emulators.dev`
directly.

## The control plane: `/_emulate/*`

Every running emulator self-describes. Start at `GET /_emulate/quickstart`
(plain-text, written for agents) or `GET /_emulate/manifest` (machine-readable:
surfaces, auth capabilities, per-operation spec coverage, connection snippets).
From TypeScript, use the client methods (`client.manifest()`, `client.ledger.list()`,
…) rather than these routes directly; the raw routes are for curl/browser
exploration and non-TS consumers.

| Endpoint                     | Use                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_emulate/openapi`      | A real OpenAPI document for the service — feed it straight to Executor's addSpec to register the emulator as an integration         |
| `POST /_emulate/credentials` | Mint a credential in the service's real shape: `{"type":"api-key"}`, bearer tokens, OAuth/OIDC clients, client-credentials apps     |
| `GET /_emulate/ledger`       | Request ledger: matched operationId, sanitized headers/body, auth identity, response status, webhook deliveries. `DELETE` clears it |
| `POST /_emulate/seed`        | Add state via the service's seed schema (e.g. WorkOS `{"oauth":{"default_access_token_ttl_seconds":60}}` to compress token expiry)  |
| `POST /_emulate/reset`       | Reset state + logs, replay seed                                                                                                     |
| `GET /_emulate/state`        | Current store snapshot                                                                                                              |
| `GET /_emulate/coverage`     | Which operations are implemented vs partial                                                                                         |
| `GET /_emulate/connections`  | Copyable SDK/env/curl snippets resolved against this instance                                                                       |

## Recipes

**Test an integration end-to-end for real** (the `connect-handoff` pattern):
`emulator.credentials.mint(...)` → register `emulator.openapiUrl` with the
product → invoke a tool through the product → prove the call landed with a
typed ledger assertion. The ledger is the proof — "the product made this
exact upstream call with this auth" — which beats asserting on the product's
own response:

```ts
const entries = await emulator.ledger.list();
const hit = entries.find((e) => (e.request.body as { subject?: string })?.subject === subject);
expect(hit?.path).toBe("/emails");
expect(hit?.response.status).toBe(200);
```

**Real OAuth/OIDC flows**: google/okta/microsoft/apple/clerk/workos mint
OAuth clients and run real authorize/token endpoints. The WorkOS emulator
additionally serves hosted AuthKit login pages (any email signs in — users
are minted on the fly, no password), an OAuth authorization server for MCP
clients, and Vault KV. Real SDK + `WORKOS_API_URL` override = the product's
untouched auth code against it. Set `EMULATE_WORKOS_AUDIENCE=<client_id>`
before `createEmulator` so minted MCP access tokens carry the right audience.

**A live, human-pokeable cloud instance with zero .env**: see
`e2e/scripts/cloud-demo.ts` and `e2e/setup/cloud.globalsetup.ts` — WorkOS +
Autumn emulators + the app's real dev stack.

## Gotchas

- **Secure cookies need HTTPS off-localhost.** Browser-driven flows work on
  `127.0.0.1`, but from another device (tailnet) the app's `secure: true`
  auth cookies are dropped over http → "Invalid login state". Front BOTH the
  app and the emulator with HTTPS (`tailscale serve`), and give the emulator
  its public origin via `baseUrl` AND the app's `WORKOS_API_URL` — the
  authorize URL the browser follows is derived from the latter.
- **State is per-process and id counters restart.** The WorkOS emulator
  mints org ids from a per-boot counter — a persisted app DB from a previous
  boot collides with new ids. Wipe the app's data dir when you restart the
  emulator (the e2e globalsetup and cloud-demo both do).
- **Don't hand-write fake upstreams.** If a scenario needs an upstream API,
  OAuth provider, or webhook source, reach for an emulator before writing a
  bespoke stub server — you get specs, auth, and the ledger for free, and
  the e2e AGENTS.md "never modify product code or stubs" rule stays intact.
