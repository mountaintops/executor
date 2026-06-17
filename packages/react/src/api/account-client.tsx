import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AccountHttpApi } from "@executor-js/api/client";
import * as Effect from "effect/Effect";

import { reportApiClientInfrastructureCause } from "./client";
import {
  getExecutorApiRequestBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "./server-connection";

// ---------------------------------------------------------------------------
// Shared account client — the provider-neutral `/account/*` surface.
//
// A separate AtomHttpApi service from `ExecutorApiClient` (which serves the
// core executor groups), mirroring the cloud split (a core client + an auth
// client). Both the cloud (WorkOS) and self-host (Better Auth) servers
// implement these paths, so this one client works for both — auth is the
// same-origin session cookie the browser sends automatically.
// ---------------------------------------------------------------------------

const AccountApiClient = AtomHttpApi.Service<"AccountApiClient">()("AccountApiClient", {
  api: AccountHttpApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) => {
    // The base URL carries the org as its first path segment (see
    // getExecutorApiRequestBaseUrl) — the URL is the only place org enters.
    let next = HttpClientRequest.prependUrl(request, getExecutorApiRequestBaseUrl());
    const authorization = getExecutorServerAuthorizationHeader();
    if (authorization) {
      next = HttpClientRequest.setHeader(next, "authorization", authorization);
    }
    return next;
  }),
  transformResponse: (effect) => Effect.tapCause(effect, reportApiClientInfrastructureCause),
});

export { AccountApiClient };
