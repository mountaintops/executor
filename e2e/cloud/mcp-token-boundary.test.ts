// Cloud-only edges of the MCP token boundary (the cross-target guarantee
// lives in scenarios/mcp-token-boundary.test.ts). Cloud mounts planes that
// don't exist on selfhost — the WorkOS session API (/api/auth/*), the org
// plane (/api/org/*), and the billing proxy — and its MCP transport is
// strictly bearer-authenticated. Two directions:
//
//   1. The MCP JWT never authenticates the cloud-only planes: those are
//      sealed-session-cookie surfaces, and a tool-access token must not
//      become a session.
//   2. The reverse: the wos-session cookie never opens /mcp. On cloud the
//      MCP plane accepts ONLY a bearer — a browser-held session must not be
//      usable as an MCP credential (no drive-by /mcp from cookie-bearing
//      contexts; CORS + bearer-only is the contract MCP clients rely on).
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const JSON_AND_SSE = "application/json, text/event-stream";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "executor-e2e-cloud-token-boundary", version: "0.0.1" },
  },
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

scenario(
  "MCP token boundary · the MCP JWT never authenticates the session, org, or billing planes",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // Control: the JWT is live against the surface it was minted for.
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

    // The cloud-only planes are cookie surfaces; each must refuse the JWT as
    // an unauthenticated call — never resolve the token's user into a session.
    // The billing proxy's control only pins "past the auth gate" (a fresh
    // org may 404 inside Autumn) — what matters everywhere is the cookie
    // clears the gate while the MCP bearer is refused AT the gate.
    const planes = [
      {
        label: "session plane",
        path: "/api/auth/me",
        method: "GET" as const,
        control: 200 as number | undefined,
      },
      {
        label: "org plane",
        path: "/api/org/domains",
        method: "GET" as const,
        control: 200 as number | undefined,
      },
      {
        label: "billing proxy",
        path: "/api/billing/customer",
        method: "POST" as const,
        control: undefined as number | undefined,
      },
    ];
    for (const plane of planes) {
      // Control: the same user's session cookie clears this plane's gate.
      const asUser = yield* Effect.promise(() =>
        fetch(new URL(plane.path, target.baseUrl), {
          method: plane.method,
          headers: {
            ...(identity.headers ?? {}),
            ...(plane.method === "POST" ? { "content-type": "application/json" } : {}),
          },
          ...(plane.method === "POST" ? { body: "{}" } : {}),
        }),
      );
      yield* Effect.promise(() => asUser.text());
      expect(
        { plane: plane.label, status: asUser.status },
        `the ${plane.label} accepts this user's session (control)`,
      ).toEqual({
        plane: plane.label,
        status: plane.control ?? expect.toSatisfy((status: number) => status !== 401),
      });

      const asMcpBearer = yield* Effect.promise(() =>
        fetch(new URL(plane.path, target.baseUrl), {
          method: plane.method,
          headers: {
            authorization: `Bearer ${bearer}`,
            ...(plane.method === "POST" ? { "content-type": "application/json" } : {}),
          },
          ...(plane.method === "POST" ? { body: "{}" } : {}),
        }),
      );
      yield* Effect.promise(() => asMcpBearer.text());
      expect(
        { plane: plane.label, status: asMcpBearer.status },
        `the ${plane.label} refuses the MCP bearer as unauthenticated`,
      ).toEqual({ plane: plane.label, status: 401 });
    }
  }),
);

scenario(
  "MCP token boundary · the app session cookie never opens an MCP session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const identity = yield* target.newIdentity();

    // Control: this cookie IS a live app session.
    const me = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/me", target.baseUrl), { headers: identity.headers ?? {} }),
    );
    yield* Effect.promise(() => me.text());
    expect(me.status, "the session cookie authenticates the app (control)").toBe(200);

    // The same cookie on /mcp: the MCP plane is bearer-only, so the request
    // is anonymous to it — challenged with the OAuth discovery pointer, not
    // silently upgraded into a tool session.
    const initialize = yield* Effect.promise(() =>
      fetch(target.mcpUrl, {
        method: "POST",
        headers: {
          ...(identity.headers ?? {}),
          accept: JSON_AND_SSE,
          "content-type": "application/json",
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      }),
    );
    const body = yield* Effect.promise(() => initialize.text());
    expect(
      { status: initialize.status, body: body.slice(0, 200) },
      "the session cookie does not open an MCP session",
    ).toEqual({ status: 401, body: expect.stringContaining("Unauthorized") });
    expect(
      initialize.headers.get("www-authenticate") ?? "",
      "the refusal is the standard OAuth challenge (begin the real flow)",
    ).toContain('Bearer resource_metadata="');
  }),
);
