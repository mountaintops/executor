import React, { createContext, useContext, useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { meAtom } from "../api/account-atoms";
import {
  clearAuthHintCookie,
  readAuthHintCookie,
  writeAuthHintCookie,
  type AuthHint,
} from "./auth-hint";

// ---------------------------------------------------------------------------
// Shared auth seam for the multiplayer apps (cloud + self-host).
//
// `useAuth()` reflects the `/account/me` query: loading → unauthenticated →
// authenticated. Provider-neutral — the only difference between cloud (WorkOS)
// and self-host (Better Auth) is which server answers `me` and how the session
// cookie was minted. Analytics stay OUT of here; a host that wants to identify
// the user (cloud → PostHog) passes an `onIdentify` callback.
//
// While `/account/me` is in flight the state is seeded from the auth-hint
// cookie (see ./auth-hint): a signed-in user's first paint is the app shell
// with their identity (no skeleton-gate), and a visitor with no hint renders
// as loading — which the host should never let happen for signed-out users
// (cloud redirects them to /login during SSR). The hint is display-only;
// the resolved `/account/me` answer always wins.
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthOrganization = {
  id: string;
  name: string;
};

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser; organization: AuthOrganization | null };

export type IdentifyFn = (
  state: Extract<AuthState, { status: "authenticated" }> | { status: "unauthenticated" },
) => void;

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

/** The auth-hint cookie as an optimistic AuthState, or null when absent. */
const hintState = (hint: AuthHint | null): AuthState | null =>
  hint && {
    status: "authenticated",
    user: hint.user,
    organization: hint.organization,
  };

const AuthProviderClient = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  const result = useAtomValue(meAtom);
  // The hint applies one frame AFTER mount: SSR always renders the loading
  // state, and React requires the first client render to match that HTML, so
  // reading the cookie during render would be a hydration mismatch. The
  // post-mount flip costs a frame, not a network round trip — and the hint
  // only seeds the in-flight window; `/account/me` is the authority from its
  // first resolution on.
  const [hint, setHint] = React.useState<AuthHint | null>(null);
  useEffect(() => {
    setHint(readAuthHintCookie());
  }, []);

  // What `/account/me` actually said — the authority.
  const resolved: AuthState = AsyncResult.match(result, {
    onInitial: () => ({ status: "loading" as const }),
    onSuccess: ({ value }) => ({
      status: "authenticated" as const,
      user: value.user,
      organization: value.organization,
    }),
    onFailure: () => ({ status: "unauthenticated" as const }),
  });

  // What consumers see — the hint papers over the in-flight window only.
  const state: AuthState = resolved.status === "loading" ? (hintState(hint) ?? resolved) : resolved;

  // Primitive identity fields of the RESOLVED state, so the effects below
  // fire only on real transitions (the objects are rebuilt every render) and
  // never on hint-derived optimistic state — identify must not report a stale
  // hint to analytics, and the hint cookie must not rewrite itself.
  const status = resolved.status;
  const userId = resolved.status === "authenticated" ? resolved.user.id : null;
  const email = resolved.status === "authenticated" ? resolved.user.email : null;
  const name = resolved.status === "authenticated" ? resolved.user.name : null;
  const avatarUrl = resolved.status === "authenticated" ? resolved.user.avatarUrl : null;
  const organizationId =
    resolved.status === "authenticated" ? (resolved.organization?.id ?? null) : null;
  const organizationName =
    resolved.status === "authenticated" ? (resolved.organization?.name ?? null) : null;

  useEffect(() => {
    if (!onIdentify) return;
    if (status === "authenticated" && userId && email !== null) {
      onIdentify({
        status: "authenticated",
        user: { id: userId, email, name, avatarUrl },
        organization: organizationId ? { id: organizationId, name: organizationName ?? "" } : null,
      });
    } else if (status === "unauthenticated") {
      onIdentify({ status: "unauthenticated" });
    }
  }, [onIdentify, status, userId, email, name, avatarUrl, organizationId, organizationName]);

  // Keep the hint cookie in step with reality so the NEXT page load seeds
  // correctly: refresh it on every confirmed identity, drop it the moment the
  // server says signed-out.
  useEffect(() => {
    if (status === "authenticated" && userId && email !== null) {
      writeAuthHintCookie({
        v: 1,
        user: { id: userId, email, name, avatarUrl },
        organization: organizationId ? { id: organizationId, name: organizationName ?? "" } : null,
      });
    } else if (status === "unauthenticated") {
      clearAuthHintCookie();
    }
  }, [status, userId, email, name, avatarUrl, organizationId, organizationName]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient onIdentify={onIdentify}>{children}</AuthProviderClient>;
};
