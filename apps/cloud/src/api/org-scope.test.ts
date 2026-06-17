import { describe, expect, it } from "@effect/vitest";

import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { classifyApiOrgScope, isApiPath, prepareApiOrgScope } from "./org-scope";

// The worker-boundary seam that turns the URL's first path segment into the org
// scope for the `/api/*` plane. The wire form is `/<slug>/api/...` (or the
// legacy `/<org_id>/api/...`); the boundary strips the prefix to the bare
// `/api/...` the app handler routes and pins the selector in an internal header.
// Org rides ONLY in the URL — a client-supplied selector header is never trusted.

describe("isApiPath", () => {
  it("matches the bare API plane", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/executions")).toBe(true);
    expect(isApiPath("/api/billing/customer")).toBe(true);
  });

  it("does not match org-scoped, MCP, or console paths", () => {
    expect(isApiPath("/acme-corp/api/executions")).toBe(false);
    expect(isApiPath("/mcp")).toBe(false);
    expect(isApiPath("/settings")).toBe(false);
    expect(isApiPath("/apiary")).toBe(false); // not `/api` nor `/api/`
  });
});

describe("classifyApiOrgScope", () => {
  it("classifies a slug-scoped API path", () => {
    expect(classifyApiOrgScope("/acme-corp/api/billing/customer")).toEqual({
      selector: "acme-corp",
      barePath: "/api/billing/customer",
    });
  });

  it("classifies the legacy org-id-scoped form", () => {
    expect(classifyApiOrgScope("/org_01ABCDEF/api/executions")).toEqual({
      selector: "org_01ABCDEF",
      barePath: "/api/executions",
    });
  });

  it("returns null for a bare API path (no selector segment)", () => {
    expect(classifyApiOrgScope("/api/billing/customer")).toBeNull();
    expect(classifyApiOrgScope("/api")).toBeNull();
  });

  it("returns null when the second segment is not `api`", () => {
    expect(classifyApiOrgScope("/acme-corp/mcp")).toBeNull();
    expect(classifyApiOrgScope("/settings/mcp")).toBeNull();
    expect(classifyApiOrgScope("/acme-corp")).toBeNull();
  });
});

describe("prepareApiOrgScope", () => {
  it("rewrites a slug-scoped request to the bare path and pins the selector", () => {
    const out = prepareApiOrgScope(
      new Request("https://executor.test/acme-corp/api/billing/customer", { method: "POST" }),
    );
    expect(new URL(out.url).pathname).toBe("/api/billing/customer");
    expect(out.headers.get(ORG_SELECTOR_HEADER)).toBe("acme-corp");
    expect(out.method).toBe("POST");
  });

  it("pins the legacy org-id selector", () => {
    const out = prepareApiOrgScope(
      new Request("https://executor.test/org_01ABCDEF/api/executions"),
    );
    expect(new URL(out.url).pathname).toBe("/api/executions");
    expect(out.headers.get(ORG_SELECTOR_HEADER)).toBe("org_01ABCDEF");
  });

  it("strips a client-supplied selector header on a bare API path", () => {
    // Org may come ONLY from the URL — a client cannot smuggle a different org
    // by setting the internal selector header on a bare `/api/...` request.
    const out = prepareApiOrgScope(
      new Request("https://executor.test/api/billing/customer", {
        headers: { [ORG_SELECTOR_HEADER]: "org_attacker" },
      }),
    );
    expect(new URL(out.url).pathname).toBe("/api/billing/customer");
    expect(out.headers.has(ORG_SELECTOR_HEADER)).toBe(false);
  });

  it("leaves a bare API path without a selector header untouched", () => {
    const req = new Request("https://executor.test/api/executions");
    expect(prepareApiOrgScope(req)).toBe(req);
  });

  it("leaves a non-API path untouched", () => {
    const req = new Request("https://executor.test/settings");
    expect(prepareApiOrgScope(req)).toBe(req);
  });
});
