import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Data, Effect, Layer, Predicate } from "effect";

import {
  IdentityProvider,
  RequestOrgSlug,
  RequestWebOrigin,
  makeScopedExecutor,
  type Principal,
} from "@executor-js/api/server";
import { IntegrationSlug, ToolAddress } from "@executor-js/sdk";

import { SelfHostScopedExecutorSeams } from "./execution";
import { SelfHostDb, type SelfHostDbHandle } from "./db/self-host-db";
import type { SelfHostPlugins } from "./plugins";

class AppsSyncRouteError extends Data.TaggedError("AppsSyncRouteError")<{
  readonly status: number;
  readonly message: string;
}> {}

const isAppsSyncRouteError = (failure: unknown): failure is AppsSyncRouteError =>
  Predicate.isTagged("AppsSyncRouteError")(failure);

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

const sourceSlugFromRoute = () =>
  HttpRouter.params.pipe(
    Effect.map((params) => params.slug ?? ""),
    Effect.flatMap((slug) =>
      slug.length > 0
        ? Effect.succeed(slug)
        : Effect.fail(
            new AppsSyncRouteError({
              status: 400,
              message: "Missing custom tools source slug",
            }),
          ),
    ),
  );

export interface SelfHostAppsSyncRouteDeps {
  readonly identity: Layer.Layer<IdentityProvider>;
  readonly db: SelfHostDbHandle;
}

const routeHandler = (
  run: (request: Request) => Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, unknown> =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const request = yield* HttpServerRequest.toWeb(httpRequest).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (request === null) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }
    return yield* run(request).pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
      Effect.catch((failure: unknown) => {
        if (Predicate.isTagged("Unauthorized")(failure)) {
          return Effect.succeed(HttpServerResponse.text("Unauthorized", { status: 401 }));
        }
        if (Predicate.isTagged("NoOrganization")(failure)) {
          return Effect.succeed(HttpServerResponse.text("Forbidden", { status: 403 }));
        }
        if (Predicate.isTagged("Unavailable")(failure)) {
          return Effect.succeed(HttpServerResponse.text("Unavailable", { status: 503 }));
        }
        if (isAppsSyncRouteError(failure)) {
          const message = failure.message;
          const status = failure.status;
          return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: message }, { status }));
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
    HttpRouter.add(
      "GET",
      "/api/apps/sources/github/:slug",
      routeHandler((request) =>
        Effect.gen(function* () {
          const identityProvider = yield* IdentityProvider;
          const principal = yield* identityProvider.authenticate(request);
          const slug = yield* sourceSlugFromRoute();
          const executor = yield* buildExecutor(principal, request);
          return yield* executor.execute(ToolAddress.make("executor.apps.get_github_source"), {
            slug,
          });
        }),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      "/api/apps/sources/github/:slug",
      routeHandler((request) =>
        Effect.gen(function* () {
          const identityProvider = yield* IdentityProvider;
          const principal = yield* identityProvider.authenticate(request);
          const slug = yield* sourceSlugFromRoute();
          const executor = yield* buildExecutor(principal, request);
          yield* executor.integrations.remove(IntegrationSlug.make(slug));
          return { removed: true };
        }),
      ),
    ),
  ).pipe(HttpRouter.provideRequest(services));
};
