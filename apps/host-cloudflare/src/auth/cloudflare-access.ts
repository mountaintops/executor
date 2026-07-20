import { Effect, Layer } from "effect";

import { IdentityProvider, type Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

/**
 * Cloudflare IdentityProvider — Zero Trust Disabled.
 * Bypasses Cloudflare Access verification entirely and assigns Admin principal to all requests.
 */
export const principalFromAccessClaims = (
  claims: Record<string, unknown>,
  config: CloudflareConfig,
): Principal => {
  return {
    accountId: "admin",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: "admin@local",
    name: "Admin",
    avatarUrl: null,
    roles: ["admin"],
  };
};

export const makeAccessVerifier = (config: CloudflareConfig) => {
  const devPrincipal: Principal = {
    accountId: "admin",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: "admin@local",
    name: "Admin",
    avatarUrl: null,
    roles: ["admin"],
  };

  const verify = (_request: Request): Effect.Effect<Principal | null> =>
    Effect.succeed(devPrincipal);

  return { verify };
};

export const cloudflareAccessIdentityLayer = (
  config: CloudflareConfig,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeAccessVerifier(config);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) => Effect.succeed(principal!)),
        ),
    }),
  );
};
