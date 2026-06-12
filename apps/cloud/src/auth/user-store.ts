// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { eq } from "drizzle-orm";

import { generateOrgSlug } from "@executor-js/api";

import { accounts, organizations } from "../db/schema";
import type { DrizzleDb } from "../db/db";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

/** An organization row whose slug has been minted (see `ensureOrganizationSlug`). */
export type SluggedOrganization = Organization & { readonly slug: string };

export const makeUserStore = (db: DrizzleDb) => {
  const getOrganization = async (id: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id));
    return rows[0] ?? null;
  };

  const slugTaken = async (slug: string) => {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    return rows.length > 0;
  };

  // The unique index can reject a candidate when two requests race to mint
  // slugs (for the same org or colliding candidates); surface that as null
  // and let the caller re-read or retry.
  const trySetSlug = async (organizationId: string, slug: string) => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a unique-index violation from a concurrent mint is an expected race, not a failure
    try {
      const [updated] = await db
        .update(organizations)
        .set({ slug })
        .where(eq(organizations.id, organizationId))
        .returning();
      return updated ?? null;
    } catch {
      return null;
    }
  };

  // Mint and persist a slug for an org that predates slugs (or was mirrored
  // before its name was known). Slugs are stable once set — renames do NOT
  // regenerate them, so org URLs survive.
  const ensureOrganizationSlug = async (org: Organization): Promise<SluggedOrganization> => {
    if (org.slug) return org as SluggedOrganization;
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = await generateOrgSlug(org.name, slugTaken);
      const updated = await trySetSlug(org.id, slug);
      if (updated?.slug) return updated as SluggedOrganization;
      // Lost a race: either another request minted this org's slug (re-read
      // and return), or the candidate got claimed by a different org (retry).
      const fresh = await getOrganization(org.id);
      if (fresh?.slug) return fresh as SluggedOrganization;
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: slug minting exhausted retries; surfacing loudly beats silently unslugged orgs
    throw new Error(`unable to mint a slug for organization ${org.id}`);
  };

  return {
    // --- Accounts ---

    ensureAccount: async (id: string) => {
      const [result] = await db.insert(accounts).values({ id }).onConflictDoNothing().returning();
      return result ?? (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!;
    },

    getAccount: async (id: string) => {
      const rows = await db.select().from(accounts).where(eq(accounts.id, id));
      return rows[0] ?? null;
    },

    // --- Organizations ---

    upsertOrganization: async (org: { id: string; name: string }) => {
      const [result] = await db
        .insert(organizations)
        .values(org)
        .onConflictDoUpdate({
          target: organizations.id,
          set: { name: org.name },
        })
        .returning();
      return result!;
    },

    getOrganization,

    getOrganizationBySlug: async (slug: string) => {
      const rows = await db.select().from(organizations).where(eq(organizations.slug, slug));
      return rows[0] ?? null;
    },

    ensureOrganizationSlug,
  };
};
