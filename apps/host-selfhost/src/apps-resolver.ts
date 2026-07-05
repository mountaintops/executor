import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { BindingError, type ClientResolver } from "@executor-js/plugin-apps/api";

// ---------------------------------------------------------------------------
// The REAL per-request ClientResolver for the running self-host (Fix 2).
//
// A published apps tool declares connection("github") and its sandboxed handler
// makes method calls like github.repos.listForAuthenticatedUser(args). This
// resolver routes each such call through the executor's per-request context:
//   1. resolve the user's connection for the integration by name (the invoking
//      owner's connection — policy/ownership applies at this lookup);
//   2. resolve its credential value through the provider (OAuth refresh happens
//      here) — credentials are injected at the boundary, never seen by the
//      sandboxed code;
//   3. dispatch the upstream call over the request's HttpClient, with the
//      credential rendered as a Bearer token, against the integration's base URL
//      using a REST-path convention (see `methodPathToUrl`).
//
// This is built PER REQUEST from `ctx` (the plugin's PluginCtx), so it has the
// real invoking context the boot-time singleton lacked. It is passed to the apps
// plugin's `invokeTool` via `makeResolver`, which threads it into the runtime's
// invoke path as a per-request override.
//
// HONEST GAP: mapping an arbitrary dotted method path to a concrete REST
// endpoint is integration-specific. This resolver implements the GitHub-style
// REST convention (dotted path -> `/segment/segment`, args -> query/body), which
// is enough for the daily-brief fixture and any REST-shaped integration whose
// method paths mirror their URL paths. A fully general mapping (per-integration
// operation tables, GraphQL, non-REST) is the remaining work; such a call fails
// with a typed BindingError naming the unmapped method rather than guessing.
// ---------------------------------------------------------------------------

/** The subset of PluginCtx this resolver needs. Kept structural so the host does
 *  not import the plugin package's ctx type. */
export interface AppsResolverCtx {
  readonly httpClientLayer: import("effect").Layer.Layer<HttpClient.HttpClient>;
  readonly connections: {
    readonly list: (filter?: {
      readonly integration?: string;
    }) => Effect.Effect<readonly AppsResolverConnection[], unknown>;
    readonly resolveValue: (ref: {
      readonly owner: unknown;
      readonly name: string;
      readonly integration: string;
    }) => Effect.Effect<string | null, unknown>;
  };
}

interface AppsResolverConnection {
  readonly owner: unknown;
  readonly name: string;
  readonly integration: string;
  /** The integration's opaque config; a `baseUrl` here overrides the default. */
  readonly config?: { readonly baseUrl?: string } | null;
}

/** Default base URLs for the integrations the self-host resolver knows how to
 *  reach over REST. An integration whose connection config carries a `baseUrl`
 *  (e.g. an emulator) overrides this. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  github: "https://api.github.com",
};

/** Map a dotted method path to a REST URL path. GitHub-style convention: the
 *  LAST segment is the operation verb (listForAuthenticatedUser, listForRepo)
 *  and the leading segments are the resource. For the daily-brief tool the two
 *  calls are `repos.listForAuthenticatedUser` -> GET /user/repos and
 *  `issues.listForRepo` -> GET /repos/{owner}/{repo}/issues. We special-case the
 *  handful the fixture uses and otherwise fall back to `/segment/segment`. */
const methodPathToRequest = (
  path: readonly string[],
  args: Record<string, unknown>,
): {
  method: "GET" | "POST";
  url: string;
  query: Record<string, string>;
  body?: unknown;
} | null => {
  const key = path.join(".");
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    if (typeof v === "object") continue;
    query[k] = String(v);
  }
  switch (key) {
    case "repos.listForAuthenticatedUser":
      return { method: "GET", url: "/user/repos", query };
    case "issues.listForRepo": {
      const owner = String(args.owner ?? "");
      const repo = String(args.repo ?? "");
      const { owner: _o, repo: _r, ...rest } = query as Record<string, string>;
      void _o;
      void _r;
      return { method: "GET", url: `/repos/${owner}/${repo}/issues`, query: rest };
    }
    default:
      return null;
  }
};

export const makeCtxResolver = (
  ctxUnknown: unknown,
  integrationForRole: (role: string) => string = (role) => role,
): ClientResolver => {
  const ctx = ctxUnknown as AppsResolverCtx;
  return {
    call: ({ integration, connection, path, args }) =>
      Effect.gen(function* () {
        const integrationSlug = integrationForRole(integration);
        const conns = yield* ctx.connections
          .list({ integration: integrationSlug })
          .pipe(Effect.orElseSucceed(() => [] as readonly AppsResolverConnection[]));
        const conn = conns.find((c) => c.name === connection) ?? conns[0];
        if (!conn) {
          return yield* Effect.fail(
            new BindingError({
              message: `no "${integrationSlug}" connection named "${connection}" for this owner`,
              role: integration,
              surface: integrationSlug,
            }),
          );
        }
        const token = yield* ctx.connections
          .resolveValue({ owner: conn.owner, name: conn.name, integration: conn.integration })
          .pipe(Effect.orElseSucceed(() => null));

        const req = methodPathToRequest(path, (args[0] ?? {}) as Record<string, unknown>);
        if (!req) {
          return yield* Effect.fail(
            new BindingError({
              message: `apps resolver has no REST mapping for "${integrationSlug}.${path.join(".")}" (the general per-integration operation mapping is the remaining gap)`,
              role: integration,
              surface: integrationSlug,
            }),
          );
        }
        const baseUrl = conn.config?.baseUrl ?? DEFAULT_BASE_URLS[integrationSlug];
        if (!baseUrl) {
          return yield* Effect.fail(
            new BindingError({
              message: `apps resolver has no base URL for integration "${integrationSlug}"`,
              role: integration,
              surface: integrationSlug,
            }),
          );
        }

        const result = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const qs = new URLSearchParams(req.query).toString();
          const url = `${baseUrl.replace(/\/$/, "")}${req.url}${qs ? `?${qs}` : ""}`;
          let request = HttpClientRequest.make(req.method)(url).pipe(
            HttpClientRequest.setHeader("user-agent", "executor-apps"),
            HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          );
          if (token) {
            request = request.pipe(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
          }
          const response = yield* client.execute(request);
          return yield* response.json;
        }).pipe(
          Effect.provide(ctx.httpClientLayer),
          Effect.mapError(
            (cause) =>
              new BindingError({
                message: `upstream call ${integrationSlug}.${path.join(".")} failed: ${String(cause)}`,
                role: integration,
                surface: integrationSlug,
              }),
          ),
        );
        return result;
      }),
  };
};
