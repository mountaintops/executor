import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { Data, Effect, Layer } from "effect";

import {
  IdentityProvider,
  RequestOrgSlug,
  RequestWebOrigin,
  makeScopedExecutor,
  type Principal,
} from "@executor-js/api/server";
import { ToolAddress } from "@executor-js/sdk";

import { SelfHostScopedExecutorSeams } from "./execution";
import { SelfHostDb, type SelfHostDbHandle } from "./db/self-host-db";
import type { SelfHostPlugins } from "./plugins";

class AppsSyncRouteError extends Data.TaggedError("AppsSyncRouteError")<{
  readonly status: number;
  readonly message: string;
}> {}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const parseJson = (request: Request): Effect.Effect<unknown, AppsSyncRouteError> =>
  Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () =>
      new AppsSyncRouteError({
        status: 400,
        message: "Invalid JSON body",
      }),
  });

const buildExecutor = (principal: Principal, request: Request) => {
  const withOrigin = makeScopedExecutor<SelfHostPlugins>(
    principal.accountId,
    principal.organizationId,
    principal.organizationName,
  ).pipe(Effect.provideService(RequestWebOrigin, { origin: new URL(request.url).origin }));
  return principal.organizationSlug
    ? withOrigin.pipe(Effect.provideService(RequestOrgSlug, { slug: principal.organizationSlug }))
    : withOrigin;
};

export interface SelfHostAppsSyncRouteDeps {
  readonly identity: Layer.Layer<IdentityProvider>;
  readonly db: SelfHostDbHandle;
}

export const makeSelfHostAppsSyncRoute = ({ identity, db }: SelfHostAppsSyncRouteDeps) => {
  const services = Layer.merge(
    SelfHostScopedExecutorSeams.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
    identity,
  );
  return HttpRouter.add(
    "POST",
    "/api/apps/sources/github/sync",
    HttpEffect.fromWebHandler(
      (request): Promise<Response> =>
        Effect.runPromise(
          Effect.gen(function* () {
            const identityProvider = yield* IdentityProvider;
            const principal = yield* identityProvider.authenticate(request);
            const payload = yield* parseJson(request);
            const executor = yield* buildExecutor(principal, request);
            const result = yield* executor.execute(
              ToolAddress.make("executor.apps.sync_github_source"),
              payload,
            );
            return jsonResponse(result);
          }).pipe(
            Effect.catchTags({
              Unauthorized: () => Effect.succeed(new Response("Unauthorized", { status: 401 })),
              NoOrganization: () => Effect.succeed(new Response("Forbidden", { status: 403 })),
              Unavailable: () => Effect.succeed(new Response("Unavailable", { status: 503 })),
              AppsSyncRouteError: (error) =>
                Effect.succeed(jsonResponse({ error: error.message }, error.status)),
            }),
            Effect.catchCause(() =>
              Effect.succeed(new Response("Internal Server Error", { status: 500 })),
            ),
            Effect.provide(services),
          ),
        ),
    ),
  );
};
