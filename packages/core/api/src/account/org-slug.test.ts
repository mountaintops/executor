import { describe, expect, it } from "@effect/vitest";

import { RESERVED_ORG_SLUGS, generateOrgSlug, isValidOrgSlug, slugifyOrgName } from "./org-slug";

describe("slugifyOrgName", () => {
  it("derives clean slugs from real-world names", () => {
    expect(slugifyOrgName("Acme Corp")).toBe("acme-corp");
    expect(slugifyOrgName("Rhys's Organization")).toBe("rhys-s-organization");
    expect(slugifyOrgName("  Café Müller GmbH  ")).toBe("cafe-muller-gmbh");
    expect(slugifyOrgName("ACME (EU) — R&D")).toBe("acme-eu-r-d");
    expect(slugifyOrgName("a.b.c")).toBe("a-b-c");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugifyOrgName("🚀🚀🚀")).toBeNull();
    expect(slugifyOrgName("--")).toBeNull();
    expect(slugifyOrgName("x")).toBeNull(); // below 2-char minimum
    expect(slugifyOrgName("")).toBeNull();
  });

  it("respects the 48-char budget", () => {
    const slug = slugifyOrgName(`${"very-".repeat(20)}long name`);
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(48);
    expect(isValidOrgSlug(slug!)).toBe(true);
  });
});

describe("isValidOrgSlug", () => {
  it("accepts the grammar", () => {
    expect(isValidOrgSlug("acme")).toBe(true);
    expect(isValidOrgSlug("acme-corp-2")).toBe(true);
    expect(isValidOrgSlug("a1")).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(isValidOrgSlug("a")).toBe(false);
    expect(isValidOrgSlug("-acme")).toBe(false);
    expect(isValidOrgSlug("acme-")).toBe(false);
    expect(isValidOrgSlug("ac--me")).toBe(false);
    expect(isValidOrgSlug("Acme")).toBe(false);
    expect(isValidOrgSlug("acme_corp")).toBe(false);
    expect(isValidOrgSlug("org_01ABC")).toBe(false); // MCP org-id namespace
    expect(isValidOrgSlug("a".repeat(49))).toBe(false);
  });

  it("rejects every reserved slug", () => {
    for (const reserved of RESERVED_ORG_SLUGS) {
      expect(isValidOrgSlug(reserved), reserved).toBe(false);
    }
  });

  it("keeps self-host's turnkey default claimable", () => {
    // Existing self-host instances boot with slug "default"; reserving it
    // would invalidate them.
    expect(isValidOrgSlug("default")).toBe(true);
  });

  it("reserves the segments routing depends on", () => {
    for (const critical of ["api", "mcp", "integrations", "policies", "login", "cdn-cgi"]) {
      expect(RESERVED_ORG_SLUGS.has(critical), critical).toBe(true);
    }
  });
});

describe("generateOrgSlug", () => {
  const taken = (slugs: ReadonlyArray<string>) => async (slug: string) => slugs.includes(slug);

  it("uses the clean derivation when free", async () => {
    expect(await generateOrgSlug("Acme Corp", taken([]))).toBe("acme-corp");
  });

  it("suffixes on collision", async () => {
    expect(await generateOrgSlug("Acme Corp", taken(["acme-corp"]))).toBe("acme-corp-2");
    expect(await generateOrgSlug("Acme Corp", taken(["acme-corp", "acme-corp-2"]))).toBe(
      "acme-corp-3",
    );
  });

  it("suffixes reserved names instead of claiming them", async () => {
    expect(await generateOrgSlug("MCP", taken([]))).toBe("mcp-2");
    expect(await generateOrgSlug("API", taken(["api-2"]))).toBe("api-3");
  });

  it("falls back to team handles for unusable names", async () => {
    // "team" itself is reserved, so the fallback starts at the first suffix.
    expect(await generateOrgSlug("🚀🚀🚀", taken([]))).toBe("team-2");
    expect(await generateOrgSlug("🚀🚀🚀", taken(["team-2"]))).toBe("team-3");
  });

  it("keeps suffixed slugs within budget", async () => {
    const longName = `${"very-".repeat(20)}long name`;
    const base = await generateOrgSlug(longName, taken([]));
    const suffixed = await generateOrgSlug(longName, taken([base]));
    expect(suffixed.length).toBeLessThanOrEqual(48);
    expect(isValidOrgSlug(suffixed)).toBe(true);
  });
});
