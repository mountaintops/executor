// ---------------------------------------------------------------------------
// API org scope — the worker-boundary seam that carries the URL's org into the
// `/api/*` plane, mirroring `prepareMcpOrgScope` for `/mcp`.
//
// On the wire the org is the FIRST PATH SEGMENT of every org-scoped API request
// (`/<slug>/api/...`, or the legacy `/<org_id>/api/...`), exactly like the
// console URL it rides alongside — the URL is the single source of org truth,
// and no client header carries org anymore. This boundary classifies that path,
// rewrites it to the bare `/api/...` the app handler actually routes, and pins
// the URL's org in the internal `ORG_SELECTOR_HEADER` the auth/account/billing
// planes read via `orgSelectorFromRequest`. Membership is STILL re-checked per
// request downstream (`authorizeOrganizationSelector`), so the header is a
// selector the worker sets from the URL, never a trust boundary or a value a
// client may supply.
// ---------------------------------------------------------------------------

import { isValidOrgSlug } from "@executor-js/api";

import { ORG_SELECTOR_HEADER } from "../auth/organization";

// Bare API path — what the app handler routes once the boundary has stripped any
// `/<slug>` prefix. `api` is itself a RESERVED slug, so a bare `/api/...` first
// segment can never be mistaken for an org selector.
export const isApiPath = (pathname: string): boolean =>
  pathname === "/api" || pathname.startsWith("/api/");

// A leading path segment counts as an org selector when it's the org's URL slug
// (the canonical console form) or has the WorkOS org-id shape (`org_…`, the
// legacy form). The slug grammar reserves `api`, so the bare API plane never
// matches. Same rule as the MCP front's `orgSelectorSegment`.
const orgSelectorSegment = (segment: string | undefined): string | null =>
  segment && (segment.startsWith("org_") || isValidOrgSlug(segment)) ? segment : null;

export type ApiOrgScope = {
  /** Org selector pinned in the URL (`/<slug>/api/...` slug or the legacy
   *  `/<org_id>/api/...` id). Resolved to an org id — and re-checked against
   *  live membership — by `authorizeOrganizationSelector` downstream. */
  readonly selector: string;
  /** The bare `/api/...` path the app handler routes, with the `/<selector>`
   *  prefix removed. */
  readonly barePath: string;
};

/**
 * Classify an org-scoped API path (`/<selector>/api/...`), returning the URL's
 * org selector + the bare path the app handler routes, or `null` when the path
 * isn't one (a bare `/api/...`, an MCP path, or a console route). Shared by
 * `app-paths.ts`'s app-owned gate and `prepareApiOrgScope`.
 */
export const classifyApiOrgScope = (pathname: string): ApiOrgScope | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const selector = orgSelectorSegment(segments[0]);
  if (selector === null || segments[1] !== "api") return null;
  return { selector, barePath: `/${segments.slice(1).join("/")}` };
};

/**
 * Normalize an API request for the app handler, which routes ONLY bare `/api/*`.
 * Rewrites `/<selector>/api/...` to its bare path and pins the URL's org in the
 * internal `ORG_SELECTOR_HEADER`. A bare `/api/*` is left untouched, except any
 * client-supplied selector header is stripped — org may come ONLY from the URL,
 * so a header can never smuggle a different org past it (a no-op for non-API
 * paths). Called by start.ts's app dispatch alongside `prepareMcpOrgScope`.
 */
export const prepareApiOrgScope = (request: Request): Request => {
  const url = new URL(request.url);
  const scope = classifyApiOrgScope(url.pathname);
  if (scope === null) {
    if (isApiPath(url.pathname) && request.headers.has(ORG_SELECTOR_HEADER)) {
      const stripped = new Request(url, request);
      stripped.headers.delete(ORG_SELECTOR_HEADER);
      return stripped;
    }
    return request;
  }
  url.pathname = scope.barePath;
  const rewritten = new Request(url, request);
  rewritten.headers.set(ORG_SELECTOR_HEADER, scope.selector);
  return rewritten;
};
