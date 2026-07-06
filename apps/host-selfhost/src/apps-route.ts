import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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

const routeHandler = (
  run: (request: Request) => Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, unknown> =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const request = yield* HttpServerRequest.toWeb(httpRequest).pipe(Effect.orDie);
    return yield* run(request).pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
      Effect.catch((error: unknown) => {
        const tag =
          error && typeof error === "object" && "_tag" in error ? String(error._tag) : null;
        if (tag === "Unauthorized") {
          return Effect.succeed(HttpServerResponse.text("Unauthorized", { status: 401 }));
        }
        if (tag === "NoOrganization") {
          return Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 }));
        }
        if (tag === "Unavailable") {
          return Effect.succeed(HttpServerResponse.text("Unavailable", { status: 503 }));
        }
        if (tag === "AppsSyncRouteError") {
          const routeError = error as AppsSyncRouteError;
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: routeError.message },
              { status: routeError.status },
            ),
          );
        }
        return Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 }));
      }),
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  });

export const makeSelfHostAppsSyncRoute = ({ identity, db }: SelfHostAppsSyncRouteDeps) => {
  const services = Layer.merge(
    SelfHostScopedExecutorSeams.pipe(Layer.provide(Layer.succeed(SelfHostDb)(db))),
    identity,
  );
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/apps/sources/github",
      routeHandler((request) =>
        Effect.gen(function* () {
          const identityProvider = yield* IdentityProvider;
          const principal = yield* identityProvider.authenticate(request);
          const executor = yield* buildExecutor(principal, request);
          return yield* executor.execute(ToolAddress.make("executor.apps.list_github_sources"), {});
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/api/apps/sources/github/sync",
      routeHandler((request) =>
        Effect.gen(function* () {
          const identityProvider = yield* IdentityProvider;
          const principal = yield* identityProvider.authenticate(request);
          const payload = yield* parseJson(request);
          const executor = yield* buildExecutor(principal, request);
          return yield* executor.execute(
            ToolAddress.make("executor.apps.sync_github_source"),
            payload,
          );
        }),
      ),
    ),
  ).pipe(HttpRouter.provideRequest(services));
};
