import { env } from "cloudflare:workers";
import { Cause, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { autumnHandler } from "autumn-js/backend";

import { WorkOSClient } from "../../auth/workos";
import { authorizeOrganizationSelector, orgSelectorFromRequest } from "../../auth/organization";
import { HttpResponseError, isServerError, toErrorServerResponse } from "../../api/error-response";

// The Autumn customer is the WorkOS ORGANIZATION, and the org is the one named
// by the console URL — NOT the session's own org. The worker boundary pins the
// URL's org selector (`/<slug>/api/billing/...`) in the request, and we resolve
// it to its WorkOS id with a live membership check before using it as the
// customerId. This is the load-bearing fix for the multi-org seat bug: a member
// of several orgs viewing a team-plan org must bill against THAT org's plan, so
// the seat cap the billing proxy reports matches the org the user is looking at.
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* Effect.mapError(
    HttpServerRequest.toWeb(request),
    () =>
      new HttpResponseError({
        status: 500,
        code: "invalid_request",
        message: "Invalid request",
      }),
  );

  const workos = yield* WorkOSClient;
  // The session identifies the USER (for the membership check + customer
  // display), never the org. The org comes ONLY from the URL selector.
  const session = yield* workos.authenticateRequest(webRequest);
  const selector = orgSelectorFromRequest(webRequest);

  if (!session || !selector) {
    return yield* new HttpResponseError({
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
  }

  // Live membership check: `null` => the caller isn't an active member of the
  // selected org (or it doesn't exist) => 403. Store/WorkOS failures fall
  // through to the outer `catchCause` as a 500.
  const org = yield* authorizeOrganizationSelector(session.userId, selector);
  if (!org) {
    return yield* new HttpResponseError({
      status: 403,
      code: "forbidden",
      message: "Forbidden",
    });
  }

  const url = new URL(webRequest.url);
  const body =
    request.method !== "GET" && request.method !== "HEAD"
      ? yield* Effect.mapError(
          request.json,
          () =>
            new HttpResponseError({
              status: 400,
              code: "invalid_json",
              message: "Invalid request body",
            }),
        )
      : undefined;

  const { statusCode, response } = yield* Effect.promise(() =>
    autumnHandler({
      request: {
        url: url.pathname,
        method: request.method,
        body,
      },
      customerId: org.id,
      customerData: {
        name: org.name,
        email: session.email,
      },
      clientOptions: {
        secretKey: env.AUTUMN_SECRET_KEY ?? "",
        ...(env.AUTUMN_API_URL ? { serverURL: env.AUTUMN_API_URL } : {}),
      },
      pathPrefix: "/api/billing",
    }),
  );

  if (statusCode >= 400) {
    console.error("[autumn] upstream error:", statusCode, response);
    return yield* new HttpResponseError({
      status: statusCode,
      code: "billing_request_failed",
      message: "Billing request failed",
    });
  }

  return HttpServerResponse.jsonUnsafe(response, { status: statusCode });
}).pipe(
  Effect.catchCause((err) => {
    if (isServerError(err)) {
      console.error("[autumn] request failed:", Cause.pretty(err));
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);

export const AutumnRoutesLive = HttpRouter.add("*", "/api/billing/*", handler);
