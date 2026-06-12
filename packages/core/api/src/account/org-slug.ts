// ---------------------------------------------------------------------------
// Organization URL slugs — the shared vocabulary for org-prefixed console URLs
// (`executor.sh/<org-slug>/policies`). One module so every host (cloud,
// self-host, cloudflare) mints, validates, and reserves slugs identically.
//
// Grammar: 2-48 chars of [a-z0-9-], no leading/trailing/double hyphen. Tighter
// than DNS labels on purpose — slugs share the URL root with console routes,
// app endpoints, and marketing pages, so anything ambiguous is reserved below.
// ---------------------------------------------------------------------------

const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,47}$/;

/**
 * Root URL segments an organization slug must never claim.
 *
 * Sources of truth (each entry exists because something routes there today or
 * predictably will):
 *  - App planes:        api, mcp, .well-known (cloud `app-paths.ts`, selfhost
 *                       envelope, cloudflare `run_worker_first`)
 *  - Console routes:    integrations, policies, secrets, tools, resume,
 *                       plugins (the shared contract), plus host extras:
 *                       api-keys, org, billing, create-org, setup-mcp (cloud),
 *                       admin, join, docs (selfhost), login (Better Auth
 *                       `mcp({ loginPage })` + cloud/selfhost login UX)
 *  - Marketing worker:  home, setup, privacy, terms, blog, pricing, careers,
 *                       changelog, _astro (executor.sh edge routes; the
 *                       non-route names are cheap insurance)
 *  - Infra:             assets (vite build output), cdn-cgi (Cloudflare),
 *                       static, public, favicon.ico, robots.txt, sitemap.xml
 *  - Auth flows:        auth, oauth, callback, logout, signin, signout,
 *                       signup, sign-in, sign-out, sign-up, register, sso,
 *                       invite, join
 *  - Predictable product words we don't want squatted: settings, account,
 *    accounts, dashboard, console, app, www, support, help, status, internal,
 *    executor, organization, organizations, org, orgs, team, teams, user,
 *    users, me, new, create, system, root, null, undefined
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  // app planes
  "api",
  "mcp",
  ".well-known",
  // console + host routes
  "integrations",
  "policies",
  "secrets",
  "tools",
  "resume",
  "plugins",
  "api-keys",
  "billing",
  "create-org",
  "setup-mcp",
  "admin",
  "docs",
  "login",
  // marketing / edge
  "home",
  "setup",
  "privacy",
  "terms",
  "blog",
  "pricing",
  "careers",
  "changelog",
  "_astro",
  // infra
  "assets",
  "cdn-cgi",
  "static",
  "public",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  // auth flows
  "auth",
  "oauth",
  "callback",
  "logout",
  "signin",
  "signout",
  "signup",
  "sign-in",
  "sign-out",
  "sign-up",
  "register",
  "sso",
  "invite",
  "join",
  // product words
  "settings",
  "account",
  "accounts",
  "dashboard",
  "console",
  "app",
  "www",
  "support",
  "help",
  "status",
  "internal",
  "executor",
  "organization",
  "organizations",
  "org",
  "orgs",
  "team",
  "teams",
  "user",
  "users",
  "me",
  "new",
  "create",
  "system",
  "root",
  "null",
  "undefined",
]);
// NOT reserved: "default" — self-host's turnkey org slug (EXECUTOR_ORG_SLUG's
// fallback) since first boot; reserving it would invalidate every existing
// instance.

/**
 * A valid, claimable org slug: matches the grammar and isn't reserved. The
 * grammar has no `_`, so slugs can never collide with cloud's `org_<id>` MCP
 * URL namespace (`classifyMcpPath` claims only `org_`-prefixed segments).
 */
export const isValidOrgSlug = (slug: string): boolean =>
  ORG_SLUG_PATTERN.test(slug) && !RESERVED_ORG_SLUGS.has(slug);

/**
 * Derive a slug candidate from an organization name. Lowercases, strips
 * diacritics, maps any run of non-alphanumerics to a single hyphen, and trims
 * to the 48-char budget. Returns `null` when nothing usable survives (emoji
 * names, etc.) — callers fall back to a generated handle.
 */
export const slugifyOrgName = (name: string): string | null => {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (slug.length < 2 || !ORG_SLUG_PATTERN.test(slug)) return null;
  return slug;
};

/**
 * Mint a unique slug for an org name: try the clean derivation, then
 * `name-2`, `name-3`, … against `isTaken`. Reserved words fall straight
 * through to the suffixed forms (`mcp` becomes `mcp-2`, which is valid).
 * Names that yield nothing usable fall back to `team` handles.
 */
export const generateOrgSlug = async (
  name: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> => {
  const base = slugifyOrgName(name) ?? "team";
  // Leave room for "-NN" suffixes within the 48-char budget.
  const trimmed = base.slice(0, 44).replace(/-+$/g, "");
  if (isValidOrgSlug(trimmed) && !(await isTaken(trimmed))) return trimmed;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${trimmed}-${n}`;
    if (isValidOrgSlug(candidate) && !(await isTaken(candidate))) return candidate;
  }
  // Practically unreachable; bail out with a random handle rather than loop.
  return `team-${Math.random().toString(36).slice(2, 8)}`;
};
