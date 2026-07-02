// ---------------------------------------------------------------------------
// Cloud code migration: GC dead DCR `oauth_client` rows + backfill the
// surviving ones' `origin_issuer` (issue #1120, Part C).
//
// The cloud counterpart to the local libSQL boot migration
// (`sqlite-oauth-client-gc-migration` in @executor-js/sdk). It runs through the
// stamped `cloud_code_migration` ledger (see runner.ts), out-of-band via
// `scripts/migrate.ts`, with `--dry-run` support and an advisory lock.
//
// It is a CODE migration, not a numbered `.sql` one, deliberately: the DCR
// classification and the registrable-origin backfill are the SAME TypeScript
// predicates the local path and the runtime reuse lookup use
// (`classifyOAuthClientGc`, `registrableOriginOfUrl`). Re-encoding the eTLD+1
// registrable-origin logic and the DCR heuristic as Postgres regex/SQL would be
// a second, drift-prone source of truth for a migration that DELETES user data.
// Reading the (small) oauth_client table and deciding in-process keeps exactly
// one source of truth across both hosts.
// ---------------------------------------------------------------------------

import {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
} from "@executor-js/sdk";

import type { CodeMigration, CodeMigrationContext } from "./runner";

interface OAuthClientRow {
  readonly tenant: string;
  readonly owner: string;
  readonly slug: string;
  readonly grant: string | null;
  readonly resource: string | null;
  readonly origin_kind: string | null;
  readonly origin_issuer: string | null;
  readonly token_url: string | null;
}

const readOAuthClients = (context: CodeMigrationContext): Promise<readonly OAuthClientRow[]> =>
  // `grant` is a reserved word in Postgres, so it must be quoted. Deterministic
  // row order keeps the dry-run report + logs stable.
  context.sql.unsafe<OAuthClientRow[]>(`
    SELECT
      tenant,
      owner,
      slug,
      "grant",
      resource,
      origin_kind,
      origin_issuer,
      token_url
    FROM oauth_client
    ORDER BY tenant, owner, slug
  `);

const referencingConnectionCount = async (
  context: CodeMigrationContext,
  row: OAuthClientRow,
): Promise<number> => {
  const [result] = await context.sql.unsafe<{ count: string | number }[]>(
    `SELECT COUNT(*)::int AS count
       FROM connection
      WHERE tenant = $1 AND oauth_client_owner = $2 AND oauth_client = $3`,
    [row.tenant, row.owner, row.slug],
  );
  return Number(result?.count ?? 0);
};

export const gcDeadDcrOAuthClientsMigration: CodeMigration = {
  name: "2026-07-02-gc-dead-dcr-oauth-clients",
  run: async (context) => {
    const rows = await readOAuthClients(context);

    let deleted = 0;
    let backfilled = 0;
    let referencedDcr = 0;

    for (const row of rows) {
      if (!isDcrClassifiedRow(row)) continue; // manual apps: never touched.

      const count = await referencingConnectionCount(context, row);
      const decision = classifyOAuthClientGc(row, count);

      if (decision.action === "delete") {
        if (!context.dryRun) {
          await context.sql.unsafe(
            `DELETE FROM oauth_client WHERE tenant = $1 AND owner = $2 AND slug = $3`,
            [row.tenant, row.owner, row.slug],
          );
        }
        deleted += 1;
        continue;
      }

      referencedDcr += 1;
      // Surviving (referenced) DCR row with no stored issuer: backfill it from
      // the registrable origin of token_url so the per-AS reuse lookup keys on
      // it and mints no new duplicate.
      if (row.origin_issuer == null) {
        const issuer = row.token_url == null ? null : registrableOriginOfUrl(row.token_url);
        if (issuer !== null) {
          if (!context.dryRun) {
            await context.sql.unsafe(
              `UPDATE oauth_client SET origin_issuer = $1
                WHERE tenant = $2 AND owner = $3 AND slug = $4`,
              [issuer, row.tenant, row.owner, row.slug],
            );
          }
          backfilled += 1;
        }
      }
    }

    const verb = context.dryRun ? "would delete" : "deleted";
    const backfillVerb = context.dryRun ? "would backfill" : "backfilled";
    return {
      summary:
        `${rows.length} oauth_client row(s): ${verb} ${deleted} orphaned DCR client(s), ` +
        `${backfillVerb} ${backfilled} of ${referencedDcr} referenced DCR client(s)`,
    };
  },
};
