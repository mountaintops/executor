import { classifyApiOrgScope, isApiPath } from "./api/org-scope";
import { classifyMcpPath } from "./mcp/mount";

// ---------------------------------------------------------------------------
// Single source of truth for "does the unified app handler own this path?" —
// the decision `start.ts` makes per request (app handler vs TanStack Start).
//
// The app handler (`ExecutorApp.make`'s `toWebHandler`) serves everything under
// `/api/*` — the typed API plus the cloud `extensions.routes` (the Autumn billing
// proxy at `/api/billing/*` and Swagger at `/api/docs` both live under `/api`) —
// plus the `/mcp` serving envelope and its `/.well-known/*` OAuth discovery docs.
// Org-scoped API requests arrive slug-first (`/<slug>/api/...`); the dispatcher
// forwards every app-owned path, rewriting the slug-scoped MCP/API forms to the
// bare path the handler routes (see `prepareMcpOrgScope` / `prepareApiOrgScope`).
// Anything else falls through to the Start router.
// ---------------------------------------------------------------------------

export const isAppOwnedPath = (pathname: string) =>
  isApiPath(pathname) ||
  classifyApiOrgScope(pathname) !== null ||
  classifyMcpPath(pathname) !== null;
