import { describe, expect, test } from "@effect/vitest";

import {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
  type OAuthClientGcRow,
} from "./oauth-gc";

// The GC decision matrix (issue #1120, Part C). These lock the conjunctive,
// fail-safe deletion predicate the local libSQL migration and the cloud code
// migration both encode: delete ⇔ classified-DCR AND zero referencing
// connections. Everything else is kept.

const explicitDcr: OAuthClientGcRow = {
  slug: "dcr-cloudflare-com",
  grant: "authorization_code",
  resource: "https://cloudflare.example/mcp",
  origin_kind: "dynamic_client_registration",
};

const legacyDcr: OAuthClientGcRow = {
  // Pre-Part-A row: null origin_kind, MCP-shaped slug + resource.
  slug: "cloudflare-mcp-2",
  grant: "authorization_code",
  resource: "https://cloudflare.example/mcp",
  origin_kind: null,
};

const manual: OAuthClientGcRow = {
  slug: "my-github-app",
  grant: "authorization_code",
  resource: null,
  origin_kind: "manual",
};

describe("isDcrClassifiedRow", () => {
  test("classifies an explicit-origin DCR row as DCR", () => {
    expect(isDcrClassifiedRow(explicitDcr)).toBe(true);
  });

  test("classifies a legacy null-origin MCP-shaped row as DCR via the heuristic", () => {
    expect(isDcrClassifiedRow(legacyDcr)).toBe(true);
    expect(isDcrClassifiedRow({ ...legacyDcr, slug: "cloudflare-mcp" })).toBe(true);
    expect(
      isDcrClassifiedRow({
        slug: "mcp",
        grant: "authorization_code",
        resource: "https://x.example/mcp?foo=1",
        origin_kind: null,
      }),
    ).toBe(true);
  });

  test("an explicit manual row is never DCR, even if MCP-shaped", () => {
    expect(isDcrClassifiedRow(manual)).toBe(false);
    expect(
      isDcrClassifiedRow({
        slug: "cloudflare-mcp",
        grant: "authorization_code",
        resource: "https://cloudflare.example/mcp",
        origin_kind: "manual",
      }),
    ).toBe(false);
  });

  test("a null-origin row that is not MCP-shaped is NOT DCR (ambiguous stays manual)", () => {
    // Non-MCP slug.
    expect(
      isDcrClassifiedRow({
        slug: "notion",
        grant: "authorization_code",
        resource: "https://notion.example/mcp",
        origin_kind: null,
      }),
    ).toBe(false);
    // MCP slug but non-MCP resource.
    expect(
      isDcrClassifiedRow({
        slug: "cloudflare-mcp",
        grant: "authorization_code",
        resource: "https://cloudflare.example/oauth",
        origin_kind: null,
      }),
    ).toBe(false);
    // MCP-shaped but wrong grant.
    expect(
      isDcrClassifiedRow({
        slug: "cloudflare-mcp",
        grant: "client_credentials",
        resource: "https://cloudflare.example/mcp",
        origin_kind: null,
      }),
    ).toBe(false);
    // Null resource can never match the resource arm of the heuristic.
    expect(
      isDcrClassifiedRow({
        slug: "cloudflare-mcp",
        grant: "authorization_code",
        resource: null,
        origin_kind: null,
      }),
    ).toBe(false);
    // A word merely containing "mcp" (not a bounded segment) does not match.
    expect(
      isDcrClassifiedRow({
        slug: "mcphaven",
        grant: "authorization_code",
        resource: "https://x.example/mcphaven",
        origin_kind: null,
      }),
    ).toBe(false);
  });
});

describe("classifyOAuthClientGc decision matrix", () => {
  test("DCR + orphaned (zero connections) → delete", () => {
    expect(classifyOAuthClientGc(explicitDcr, 0)).toEqual({
      action: "delete",
      reason: "dcr-orphaned",
    });
    expect(classifyOAuthClientGc(legacyDcr, 0)).toEqual({
      action: "delete",
      reason: "dcr-orphaned",
    });
  });

  test("DCR + referenced (>=1 connection) → keep", () => {
    expect(classifyOAuthClientGc(explicitDcr, 1)).toEqual({
      action: "keep",
      reason: "referenced",
    });
    expect(classifyOAuthClientGc(legacyDcr, 3)).toEqual({
      action: "keep",
      reason: "referenced",
    });
  });

  test("manual + orphaned → keep (a hand-registered app is never GC'd)", () => {
    expect(classifyOAuthClientGc(manual, 0)).toEqual({ action: "keep", reason: "not-dcr" });
  });

  test("manual + referenced → keep", () => {
    expect(classifyOAuthClientGc(manual, 5)).toEqual({ action: "keep", reason: "not-dcr" });
  });

  test("legacy-heuristic-classified DCR is treated exactly like an explicit DCR row", () => {
    // Same (row-shape, count) inputs produce the same decision whether the DCR
    // classification came from origin_kind or the heuristic.
    expect(classifyOAuthClientGc(legacyDcr, 0).action).toBe(
      classifyOAuthClientGc(explicitDcr, 0).action,
    );
    expect(classifyOAuthClientGc(legacyDcr, 2).action).toBe(
      classifyOAuthClientGc(explicitDcr, 2).action,
    );
  });

  test("idempotency: once a DCR row is referenced (kept), a re-run keeps it (never deletes)", () => {
    // A second GC pass sees the same referenced DCR rows and the same manual
    // rows; none flip to delete. (Orphaned DCR rows are gone after pass 1, so
    // the only rows a second pass sees are keeps.)
    for (const count of [1, 2, 10]) {
      expect(classifyOAuthClientGc(explicitDcr, count).action).toBe("keep");
      expect(classifyOAuthClientGc(legacyDcr, count).action).toBe("keep");
    }
    expect(classifyOAuthClientGc(manual, 0).action).toBe("keep");
  });
});

describe("registrableOriginOfUrl (issuer backfill value)", () => {
  test("collapses a subdomain token host to its registrable origin", () => {
    expect(registrableOriginOfUrl("https://oauth.cloudflare.com/token")).toBe(
      "https://cloudflare.com",
    );
    expect(registrableOriginOfUrl("https://login.microsoftonline.com/common/oauth2/token")).toBe(
      "https://microsoftonline.com",
    );
  });

  test("keeps an already-registrable host as-is", () => {
    expect(registrableOriginOfUrl("https://github.com/login/oauth/access_token")).toBe(
      "https://github.com",
    );
  });

  test("respects the two-part public suffix carve-out", () => {
    expect(registrableOriginOfUrl("https://api.foo.co.uk/token")).toBe("https://foo.co.uk");
  });

  test("preserves scheme and port for loopback / dev token hosts", () => {
    expect(registrableOriginOfUrl("http://127.0.0.1:8787/token")).toBe("http://127.0.0.1:8787");
    expect(registrableOriginOfUrl("http://localhost:4788/oauth/token")).toBe(
      "http://localhost:4788",
    );
  });

  test("returns null for a non-URL token value", () => {
    expect(registrableOriginOfUrl("not a url")).toBeNull();
    expect(registrableOriginOfUrl("")).toBeNull();
  });
});
