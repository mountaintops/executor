// ---------------------------------------------------------------------------
// Garbage collection + backfill for legacy Dynamic Client Registration (DCR)
// `oauth_client` rows (issue #1120, Part C).
//
// Old always-register behavior minted a fresh `oauth_client` per connect
// attempt ("cloudflare-mcp", "cloudflare-mcp-2", …). Parts A+B stopped the
// multiplication (per-AS reuse) and hid the rows from pickers, but the dead
// rows remain and legacy rows have `origin_issuer = NULL`, so the reuse lookup
// can't key on them. This module supplies the shared, testable predicates that
// both host paths (local libSQL boot migration, cloud Drizzle SQL migration)
// encode:
//
//   1. GC: delete a row that is classified DCR AND has ZERO referencing
//      connections. The predicate is conjunctive and fail-safe — an ambiguous
//      row (manual, or DCR but still referenced) is always KEPT.
//   2. Backfill: for a surviving DCR row with `origin_issuer IS NULL`, set it
//      to the registrable origin of `token_url` so the per-AS reuse lookup can
//      find it and mint no new duplicate.
//
// The DCR classification here is the single source of truth: `oauth-service`'s
// `parseOAuthClientOrigin` calls `isDcrClassifiedRow`, and the SQL migrations
// mirror the exact same predicate. Keep the three in lockstep.
// ---------------------------------------------------------------------------

/** Parse a string into a URL, or null when it is not a valid absolute URL. */
export const parseUrl = (value: string): URL | null => {
  if (!URL.canParse(value)) return null;
  return new URL(value);
};

/** Canonicalize a discovered issuer to `origin` + path with trailing slashes
 *  stripped (RFC 8414 issuers are compared without a trailing slash). Null for
 *  a blank or unparseable value. Part A's DCR-identity canonicalization. */
export const canonicalIssuerUrl = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const url = parseUrl(trimmed);
  if (url === null) return null;
  const path = url.pathname.replace(/\/+$/g, "");
  return path.length > 0 ? `${url.origin}${path}` : url.origin;
};

export const hostOfUrl = (value: string): string | null =>
  parseUrl(value)?.host.toLowerCase() ?? null;

// Two-label public suffixes we must not collapse past (so `api.foo.co.uk`
// registers under `foo.co.uk`, not `co.uk`). A pragmatic short list — the full
// PSL is overkill for keying DCR clients.
const commonTwoPartPublicSuffixes = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "com.br",
  "com.mx",
  "com.sg",
]);

/** The registrable domain of a hostname (eTLD+1), with the pragmatic two-part
 *  public-suffix carve-out. `localhost`, bare IPv4, and anything with a port
 *  are returned unchanged. */
export const registrableHostname = (hostname: string): string => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return host;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const suffix = labels.slice(-2).join(".");
  const labelCount = commonTwoPartPublicSuffixes.has(suffix) ? 3 : 2;
  return labels.slice(-labelCount).join(".");
};

/** The registrable host (incl. port when the hostname is registered verbatim)
 *  of a URL, or null when the value is not a URL. */
export const registrableHostOfUrl = (value: string): string | null => {
  const url = parseUrl(value);
  if (url === null) return null;
  const hostname = registrableHostname(url.hostname);
  return hostname === url.hostname.toLowerCase() ? url.host.toLowerCase() : hostname;
};

/** The registrable ORIGIN of a URL: its scheme + the registrable host (dropping
 *  any subdomain). Used to backfill a legacy DCR row's `origin_issuer` from its
 *  `token_url`, so the per-AS reuse lookup can find it. Null when not a URL.
 *
 *  Preserves scheme and port (a loopback `http://127.0.0.1:8787` token host
 *  keeps its port). Reuses `registrableHostname` — no duplicated eTLD logic. */
export const registrableOriginOfUrl = (value: string): string | null => {
  const url = parseUrl(value);
  if (url === null) return null;
  const registrable = registrableHostname(url.hostname);
  // When the hostname collapses to a registrable domain, rebuild the origin
  // from scheme + registrable host + original port; otherwise keep url.origin
  // verbatim (covers localhost / IPv4 / already-registrable hosts, incl. port).
  if (registrable === url.hostname.toLowerCase()) return url.origin;
  const port = url.port.length > 0 ? `:${url.port}` : "";
  return `${url.protocol}//${registrable}${port}`;
};

/** The minimal shape the DCR classifier reads off an `oauth_client` row. Every
 *  field is optional/unknown so it applies equally to a fuma row, a raw SQL
 *  row, or a hand-built test fixture. */
export interface OAuthClientGcRow {
  readonly slug?: unknown;
  readonly grant?: unknown;
  readonly resource?: unknown;
  readonly origin_kind?: unknown;
}

const legacyMcpSlug = (slug: string): boolean => /(^|[-_])mcp($|[-_])/.test(slug);
const legacyMcpResource = (resource: string): boolean => /(^|\/)mcp($|[/?#])/.test(resource);

/**
 * Is this `oauth_client` row a Dynamic Client Registration client?
 *
 * True when EITHER:
 *  - it carries the explicit `origin_kind = 'dynamic_client_registration'`
 *    stamp (rows minted after Part A), OR
 *  - it is a legacy null-origin row that matches the MCP heuristic: an
 *    `authorization_code` grant whose slug and resource both look MCP-shaped
 *    (`…mcp…`). This is the same heuristic `parseOAuthClientOrigin` applies to
 *    classify pre-Part-A rows, kept in ONE place so the runtime and the GC
 *    migrations agree exactly.
 *
 * A row that does not match either arm is treated as manual and is NEVER a GC
 * candidate — the conservative default that protects hand-registered apps.
 */
export const isDcrClassifiedRow = (row: OAuthClientGcRow): boolean => {
  if (row.origin_kind === "dynamic_client_registration") return true;
  if (row.origin_kind != null) return false;
  if (row.grant !== "authorization_code") return false;
  const slug = row.slug == null ? "" : String(row.slug);
  const resource = row.resource == null ? "" : String(row.resource);
  return legacyMcpSlug(slug) && legacyMcpResource(resource);
};

/** The GC decision for one `oauth_client` row. */
export type OAuthClientGcDecision =
  /** Classified DCR AND unreferenced — safe to delete. */
  | { readonly action: "delete"; readonly reason: "dcr-orphaned" }
  /** Kept — either not DCR, or DCR but still referenced by a connection. */
  | { readonly action: "keep"; readonly reason: "not-dcr" | "referenced" };

/**
 * Decide whether a single `oauth_client` row should be garbage-collected.
 *
 * The deletion predicate is strictly conjunctive and fail-safe:
 *   delete ⇔ isDcrClassifiedRow(row) AND referencingConnectionCount === 0
 *
 * Anything else is kept. A manual app is kept even when orphaned (users delete
 * their own apps deliberately); a DCR app is kept while any connection still
 * references it (deleting it would break refresh/reconnect for that
 * connection). `referencingConnectionCount` is the number of `connection` rows
 * whose stored `(oauth_client_owner, oauth_client)` reference resolves to this
 * row's `(owner, slug)`.
 */
export const classifyOAuthClientGc = (
  row: OAuthClientGcRow,
  referencingConnectionCount: number,
): OAuthClientGcDecision => {
  if (!isDcrClassifiedRow(row)) return { action: "keep", reason: "not-dcr" };
  if (referencingConnectionCount > 0) return { action: "keep", reason: "referenced" };
  return { action: "delete", reason: "dcr-orphaned" };
};
