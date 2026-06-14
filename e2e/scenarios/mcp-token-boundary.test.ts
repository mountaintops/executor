// An MCP OAuth access token is scoped to the MCP server, full stop. A client
// that completed the /mcp OAuth flow holds a bearer the user consented to for
// TOOL ACCESS — replaying it against the product's REST API must never
// authenticate, even though both planes live on the same origin and resolve
// the same user. Both targets mint through the real discovery → DCR → PKCE
// authorize → token flow (cloud: a WorkOS-minted JWT; selfhost: Better Auth's
// opaque token) — the same bytes a real MCP client holds.
//
// Each probe has a paired control: the same request authenticated as the same
// user through the front door succeeds, so a refusal can never be explained
// by a wrong path or a malformed request — only by the credential. The
// universal guarantee under test is "does not authenticate" — pinned as
// "never 2xx", since the refusal *rendering* differs per plane (selfhost's
// account plane renders some unauthenticated rejections as 500).
//
// On cloud we additionally pin the exact status: a replayed bearer must come
// back 401 invalid_api_key, NOT 503. The cloud REST gate validates any bearer
// as an api key via WorkOS /api_keys/validations; real WorkOS answers a
// non-key value with 200 { api_key: null } (confirmed against api.workos.com
// dev), which the gate renders as a clean 401. A 503 would mean the validator
// *threw* — the failure mode of the old WorkOS emulator, which 404'd that
// lookup. Asserting 401 here is the end-to-end proof that the emulator
// (@executor-js/emulate ≥ 0.7.1) now mirrors the real wire.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const JSON_AND_SSE = "application/json, text/event-stream";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "executor-e2e-token-boundary", version: "0.0.1" },
  },
};

/** Every protected REST plane a leaked/replayed MCP bearer must NOT open. */
const PROTECTED_API_PROBES: ReadonlyArray<{
  readonly label: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}> = [
  { label: "tools list", path: "/api/tools" },
  { label: "integrations list", path: "/api/integrations" },
  { label: "connections list", path: "/api/connections" },
  {
    label: "code execution",
    path: "/api/executions",
    method: "POST",
    body: JSON.stringify({ code: "return 1;" }),
  },
  { label: "account profile", path: "/api/account/me" },
  { label: "API-key management", path: "/api/account/api-keys" },
];

const probeRequest = (
  baseUrl: string,
  probe: (typeof PROTECTED_API_PROBES)[number],
  headers: Record<string, string>,
): Promise<Response> =>
  fetch(new URL(probe.path, baseUrl), {
    method: probe.method ?? "GET",
    headers: { ...headers, ...(probe.body ? { "content-type": "application/json" } : {}) },
    ...(probe.body ? { body: probe.body } : {}),
  });

scenario(
  "MCP token boundary · an MCP OAuth bearer opens an MCP session but none of the app's REST API",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    yield* Api; // gate: this target mounts the REST plane the probes exercise
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(identity);

    // Control: the token is live on the surface it was minted for. Without
    // this, every refusal below could be explained by a dud token.
    const initialize = yield* Effect.promise(() =>
      fetch(target.mcpUrl, {
        method: "POST",
        headers: {
          accept: JSON_AND_SSE,
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      }),
    );
    yield* Effect.promise(() => initialize.text());
    expect(initialize.status, "the MCP bearer opens an MCP session (control)").toBe(200);
    expect(
      initialize.headers.get("mcp-session-id"),
      "the MCP server issued a real session for this bearer",
    ).toBeTruthy();

    // Every refusal is judged against a per-probe control, and breaches are
    // collected so a failure names every plane the bearer opened at once.
    const isCloud = target.name === "cloud";
    const breached: Array<{ probe: string; status: number; body: string }> = [];
    // Cloud only: a refusal that is not a clean 401 (e.g. a 503 validation
    // outage) means the WorkOS api-key validator threw instead of answering
    // 200 { api_key: null } — the old emulator's 404 behaviour.
    const misrendered: Array<{ probe: string; status: number }> = [];
    for (const probe of PROTECTED_API_PROBES) {
      // Control: the same request as the same user through the front door.
      const asUser = yield* Effect.promise(() =>
        probeRequest(target.baseUrl, probe, identity.headers ?? {}),
      );
      yield* Effect.promise(() => asUser.text());
      expect(
        { probe: probe.label, status: asUser.status },
        `${probe.label} answers this user's session (control)`,
      ).toEqual({ probe: probe.label, status: 200 });

      // The guarantee: the same live MCP bearer never authenticates it. The
      // user consented to MCP tool access — not to API-key management, code
      // execution, or anything else on the REST plane.
      const asMcpBearer = yield* Effect.promise(() =>
        probeRequest(target.baseUrl, probe, { authorization: `Bearer ${bearer}` }),
      );
      const body = yield* Effect.promise(() => asMcpBearer.text());
      if (asMcpBearer.status < 400) {
        breached.push({ probe: probe.label, status: asMcpBearer.status, body: body.slice(0, 200) });
      } else if (isCloud && asMcpBearer.status !== 401) {
        misrendered.push({ probe: probe.label, status: asMcpBearer.status });
      }
    }
    expect(breached, "no REST plane accepted the MCP bearer").toEqual([]);
    expect(
      misrendered,
      "cloud rejects the MCP bearer as a clean 401 invalid_api_key, not a 503 validation outage",
    ).toEqual([]);
  }),
);
