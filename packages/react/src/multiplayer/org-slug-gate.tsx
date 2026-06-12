import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

// ---------------------------------------------------------------------------
// Org-slug URL canonicalization for org-scoped hosts (cloud, self-host,
// cloudflare). Console routes live under an optional `{-$orgSlug}` segment, so
// the same tree serves `/policies` and `/acme/policies`; this gate, mounted
// inside the authenticated shell, pins the URL to the ACTIVE organization's
// slug:
//
//   - bare URL            → replace with `/<active-slug>/…` (canonicalize)
//   - active slug in URL  → render
//   - other slug in URL   → `foreignSlug(slug)` when provided (cloud renders a
//                           switch-organization resolver); single-org hosts
//                           omit it and the URL canonicalizes
//
// "Foreign" is judged against where the SESSION has been, not just the URL:
// when the active slug changes while mounted (an org create/switch elsewhere
// in the app re-resolves `/account/me`), the URL is the stale side and
// canonicalizes forward. Treating that as a foreign URL would switch the
// session straight back — racing the in-flight navigation and rotating the
// session cookie twice (WorkOS sealed-session refreshes are single-use, so
// the loser of that race invalidates the winner).
//
// The URL slug is a SELECTOR, not a trust boundary — every API call is scoped
// by the session server-side, same as the MCP URL-pinned org.
// ---------------------------------------------------------------------------

export interface OrgSlugGateProps {
  /** The active organization's slug (from `useAuth().organization`). */
  readonly activeSlug: string;
  /**
   * Rendered INSTEAD of children when the URL carries a different org's slug
   * at load time. Multi-org hosts resolve it (switch the session, or bounce);
   * single-org hosts leave it unset and the URL canonicalizes to the active
   * slug.
   */
  readonly foreignSlug?: (slug: string) => ReactNode;
  readonly children: ReactNode;
}

export function OrgSlugGate(props: OrgSlugGateProps) {
  const { activeSlug, foreignSlug } = props;
  const params = useParams({ strict: false }) as { orgSlug?: string };
  const urlSlug = params.orgSlug ?? null;
  const navigate = useNavigate();

  // The active slug the URL last agreed with. While it differs from
  // `activeSlug`, the session has moved out from under the URL (create/switch
  // elsewhere in the app) — that is never a foreign URL.
  const agreedSlug = useRef(activeSlug);
  useEffect(() => {
    if (urlSlug === activeSlug) agreedSlug.current = activeSlug;
  }, [urlSlug, activeSlug]);
  const sessionMoved = agreedSlug.current !== activeSlug;

  const isForeign = urlSlug !== null && urlSlug !== activeSlug && !sessionMoved;
  const needsCanonicalize = urlSlug !== activeSlug && !(isForeign && foreignSlug);

  useEffect(() => {
    if (!needsCanonicalize) return;
    // Re-target the CURRENT route with the active slug. `to: "."` +
    // `search: true` keeps path and query (deep links like
    // `/integrations/add/mcp?url=…` canonicalize in place); only the orgSlug
    // param changes.
    void navigate({
      to: ".",
      params: (previous: Record<string, string>) => ({ ...previous, orgSlug: activeSlug }),
      search: true,
      replace: true,
    });
  }, [needsCanonicalize, activeSlug, navigate]);

  if (isForeign && foreignSlug) return <>{foreignSlug(urlSlug)}</>;

  // Render through while canonicalizing — the target is the same route, so
  // withholding children would only flash the page.
  return <>{props.children}</>;
}
