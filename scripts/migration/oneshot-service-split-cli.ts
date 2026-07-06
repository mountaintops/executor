/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: one-shot migration CLI */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "../../apps/cloud/node_modules/postgres/src/index.js";

import {
  planMigration,
  renderOrgDiff,
  renderSummary,
  tenantHash,
  verifyPolicyRewriteNeverWidens,
  type ConnectionRow,
  type DefinitionRow,
  type IntegrationRow,
  type MigrationInput,
  type OrgPlan,
  type ToolPolicyRow,
  type ToolRow,
} from "./oneshot-service-split";

interface SqlClient {
  readonly unsafe: <T extends readonly object[] = readonly Record<string, unknown>[]>(
    query: string,
    params?: readonly unknown[],
  ) => Promise<T>;
  readonly begin: <T>(fn: (sql: SqlClient) => Promise<T>) => Promise<T>;
  readonly end: (options?: { readonly timeout?: number }) => Promise<void>;
}

const args = process.argv.slice(2);
const hasArg = (name: string): boolean => args.includes(name);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const apply = hasArg("--apply");
const inputJson = argValue("--input-json");
const outputDir = resolve(
  argValue("--output-dir") ?? "~/agent-workspace/scratch/oneshot-migration-dryrun",
).replace(/^~(?=\/)/, process.env.HOME ?? "~");
const trafficLastTenant = argValue("--traffic-last-tenant");
const databaseUrl = argValue("--database-url") ?? process.env.DATABASE_URL;

const parseInputJson = (path: string): MigrationInput =>
  JSON.parse(readFileSync(path, "utf8")) as MigrationInput;

const readRows = async <T extends readonly object[]>(sql: SqlClient, query: string): Promise<T> =>
  sql.unsafe<T>(query);

const readCompletedTenants = async (
  sql: SqlClient,
  dryRun: boolean,
): Promise<readonly string[]> => {
  const [table] = await sql.unsafe<{ ledger_table: string | null }[]>(
    "SELECT to_regclass('public.google_microsoft_service_split_org_migration')::text AS ledger_table",
  );
  if (!table?.ledger_table) {
    if (dryRun) return [];
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS google_microsoft_service_split_org_migration (
        tenant text PRIMARY KEY,
        time_completed bigint NOT NULL
      )
    `);
    return [];
  }
  const rows = await sql.unsafe<{ tenant: string }[]>(
    "SELECT tenant FROM google_microsoft_service_split_org_migration ORDER BY tenant",
  );
  return rows.map((row) => row.tenant);
};

const readDatabaseInput = async (sql: SqlClient, dryRun: boolean): Promise<MigrationInput> => {
  const completedTenants = await readCompletedTenants(sql, dryRun);
  const integrations = await readRows<IntegrationRow[]>(
    sql,
    `
      SELECT tenant, slug, plugin_id, name, description, config, health_check, config_revised_at,
        can_remove, can_refresh, created_at::text, updated_at::text, row_id
      FROM integration
      WHERE plugin_id IN ('google', 'microsoft')
         OR slug IN ('google', 'microsoft')
         OR tenant IN (
          SELECT tenant FROM integration
          WHERE (plugin_id = 'google' AND slug = 'google')
             OR (plugin_id = 'microsoft' AND slug = 'microsoft')
         )
      ORDER BY tenant, slug
    `,
  );
  const connections = await readRows<ConnectionRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, integration, name, template, provider, item_ids,
        identity_label, description, last_health, tools_synced_at, oauth_client,
        oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url,
        provider_state, created_at::text, updated_at::text, row_id
      FROM connection
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE (plugin_id = 'google' AND slug = 'google')
           OR (plugin_id = 'microsoft' AND slug = 'microsoft')
      )
      ORDER BY tenant, integration, owner, subject, name
    `,
  );
  const tools = await readRows<ToolRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, integration, connection, plugin_id, name, description,
        input_schema, output_schema, annotations, created_at::text, updated_at::text, row_id
      FROM tool
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE (plugin_id = 'google' AND slug = 'google')
           OR (plugin_id = 'microsoft' AND slug = 'microsoft')
      )
      ORDER BY tenant, integration, connection, name
    `,
  );
  const definitions = await readRows<DefinitionRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, integration, connection, plugin_id, name, schema,
        created_at::text, row_id
      FROM definition
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE (plugin_id = 'google' AND slug = 'google')
           OR (plugin_id = 'microsoft' AND slug = 'microsoft')
      )
      ORDER BY tenant, integration, connection, name
    `,
  );
  const policies = await readRows<ToolPolicyRow[]>(
    sql,
    `
      SELECT tenant, owner, subject, id, pattern, action, position, created_at::text,
        updated_at::text, row_id
      FROM tool_policy
      WHERE tenant IN (
        SELECT tenant FROM integration
        WHERE (plugin_id = 'google' AND slug = 'google')
           OR (plugin_id = 'microsoft' AND slug = 'microsoft')
      )
      ORDER BY tenant, owner, subject, position, id
    `,
  );
  return {
    integrations,
    connections,
    tools,
    definitions,
    policies,
    completedTenants,
    trafficLastTenant,
  };
};

const scrubJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]) => [key, scrubJson(inner)]),
    );
  }
  return value;
};

const stableId = (...parts: readonly string[]): string => {
  const text = parts.join("\u0000");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `oneshot_${hash.toString(36)}`;
};

const serviceToolSql = (presetId: string): string => {
  const prefixesByPreset: Readonly<Record<string, readonly string[]>> = {
    "google-calendar": ["calendar."],
    "google-gmail": ["gmail."],
    "google-sheets": ["sheets."],
    "google-drive": ["drive."],
    "google-docs": ["docs."],
    "google-slides": ["slides."],
    "google-forms": ["forms."],
    "google-tasks": ["tasks."],
    "google-people": ["people."],
    "google-photos-library": ["photoslibrary."],
    "google-photos-picker": ["photospicker."],
    "google-chat": ["chat."],
    "google-keep": ["keep."],
    "google-youtube-data": ["youtube."],
    "google-search-console": ["searchconsole.", "webmasters."],
    "google-classroom": ["classroom."],
    "google-admin-directory": ["admin."],
    "google-admin-reports": ["admin."],
    "google-apps-script": ["script."],
    "google-bigquery": ["bigquery."],
    "google-cloud-resource-manager": ["cloudresourcemanager."],
    profile: ["meUser.", "usersUser.", "meProfilePhoto."],
    mail: [
      "meMessage.",
      "usersMessage.",
      "meMail",
      "usersMail",
      "meMailbox",
      "meOutlook",
      "usersOutlook",
    ],
    calendar: ["meCalendar", "usersCalendar", "meEvent.", "usersEvent."],
    contacts: ["meContact", "usersContact", "mePerson.", "usersPerson."],
    tasks: ["meTodo.", "usersTodo."],
    planner: ["planner.", "mePlanner.", "usersPlanner."],
    files: ["drives", "meDrive", "usersDrive", "groupsDrive", "shares"],
    excel: ["workbook", "Workbook"],
    sites: ["sites"],
    onenote: ["meOnenote", "usersOnenote", "groupsOnenote", "sitesOnenote"],
    "teams-chat": ["chats", "meChat"],
    "teams-channels": ["teams", "teamwork", "meTeam", "groupsTeam"],
    "meetings-calls": ["communications", "meOnlineMeeting", "usersOnlineMeeting"],
  };
  const prefixes = prefixesByPreset[presetId] ?? [];
  const clauses = prefixes.map((prefix) => `name LIKE '${prefix.replaceAll("'", "''")}%'`);
  if (presetId.startsWith("google-")) clauses.push("name LIKE 'oauth2.%'");
  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : "false";
};

const applyOrg = async (sql: SqlClient, org: OrgPlan): Promise<void> => {
  if (org.completed) return;
  await sql.begin(async (tx) => {
    const now = new Date();
    for (const row of org.integrations.filter((item) => item.action === "create")) {
      await tx.unsafe(
        `
          INSERT INTO integration (
            slug, plugin_id, name, description, config, health_check, config_revised_at,
            can_remove, can_refresh, created_at, updated_at, row_id, tenant
          )
          VALUES ($1, $2, $3, $4, $5::json, NULL, NULL, true, true, $6, $6, $7, $8)
          ON CONFLICT (tenant, slug) DO NOTHING
        `,
        [
          row.target.slug,
          row.target.pluginId,
          row.target.name,
          row.target.description,
          JSON.stringify(scrubJson(row.config)),
          now,
          stableId("integration", org.tenant, row.target.slug),
          org.tenant,
        ],
      );
    }

    for (const row of org.connections.filter((item) => item.action === "clone")) {
      await tx.unsafe(
        `
          INSERT INTO connection (
            integration, name, template, provider, item_ids, identity_label, description,
            last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
            expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
            row_id, tenant, owner, subject
          )
          SELECT $1, name, template, provider, item_ids, identity_label, description,
            NULL, NULL, oauth_client, oauth_client_owner, refresh_item_id, expires_at,
            oauth_scope, oauth_token_url, provider_state, created_at, $2, $3, tenant, owner, subject
          FROM connection
          WHERE tenant = $4 AND owner = $5 AND subject = $6 AND integration = $7 AND name = $8
          ON CONFLICT (tenant, owner, subject, integration, name) DO NOTHING
        `,
        [
          row.targetIntegration,
          now,
          stableId(
            "connection",
            org.tenant,
            row.source.owner,
            row.source.subject,
            row.targetIntegration,
            row.source.name,
          ),
          org.tenant,
          row.source.owner,
          row.source.subject,
          row.source.integration,
          row.source.name,
        ],
      );
    }

    for (const integration of org.integrations) {
      const whereTools = serviceToolSql(integration.target.presetId);
      await tx.unsafe(
        `
          INSERT INTO tool (
            integration, connection, plugin_id, name, description, input_schema, output_schema,
            annotations, created_at, updated_at, row_id, tenant, owner, subject
          )
          SELECT $1, connection, plugin_id, name, description, input_schema, output_schema,
            annotations, created_at, $2, concat($3::text, '_', row_id), tenant, owner, subject
          FROM tool
          WHERE tenant = $4 AND integration = $5 AND ${whereTools}
          ON CONFLICT (tenant, owner, subject, integration, connection, name) DO NOTHING
        `,
        [
          integration.target.slug,
          now,
          stableId("tool", org.tenant, integration.target.slug),
          org.tenant,
          integration.source.slug,
        ],
      );
      await tx.unsafe(
        `
          INSERT INTO definition (
            integration, connection, plugin_id, name, schema, created_at, row_id, tenant, owner, subject
          )
          SELECT $1, connection, plugin_id, name, schema, created_at, concat($2::text, '_', row_id),
            tenant, owner, subject
          FROM definition
          WHERE tenant = $3 AND integration = $4 AND ${whereTools}
          ON CONFLICT (tenant, owner, subject, integration, connection, name) DO NOTHING
        `,
        [
          integration.target.slug,
          stableId("definition", org.tenant, integration.target.slug),
          org.tenant,
          integration.source.slug,
        ],
      );
    }

    for (const policy of org.policies.filter((item) => item.action === "rewrite")) {
      await tx.unsafe(
        "DELETE FROM tool_policy WHERE tenant = $1 AND owner = $2 AND subject = $3 AND id = $4",
        [org.tenant, policy.policy.owner, policy.policy.subject, policy.policy.id],
      );
      for (const [index, pattern] of policy.afterPatterns.entries()) {
        await tx.unsafe(
          `
            INSERT INTO tool_policy (
              id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject
            )
            VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)
            ON CONFLICT (tenant, owner, subject, id) DO NOTHING
          `,
          [
            policy.afterPatterns.length === 1
              ? policy.policy.id
              : `${policy.policy.id}_${index + 1}`,
            pattern,
            policy.policy.action,
            policy.policy.position,
            now,
            stableId("policy", org.tenant, policy.policy.id, pattern),
            org.tenant,
            policy.policy.owner,
            policy.policy.subject,
          ],
        );
      }
    }

    for (const monolith of org.deleteMonoliths) {
      await tx.unsafe("DELETE FROM definition WHERE tenant = $1 AND integration = $2", [
        org.tenant,
        monolith.slug,
      ]);
      await tx.unsafe("DELETE FROM tool WHERE tenant = $1 AND integration = $2", [
        org.tenant,
        monolith.slug,
      ]);
      await tx.unsafe("DELETE FROM connection WHERE tenant = $1 AND integration = $2", [
        org.tenant,
        monolith.slug,
      ]);
      await tx.unsafe(
        "DELETE FROM integration WHERE tenant = $1 AND slug = $2 AND plugin_id = $3",
        [org.tenant, monolith.slug, monolith.plugin_id],
      );
    }

    await tx.unsafe(
      `
        INSERT INTO google_microsoft_service_split_org_migration (tenant, time_completed)
        VALUES ($1, $2)
        ON CONFLICT (tenant) DO UPDATE SET time_completed = EXCLUDED.time_completed
      `,
      [org.tenant, Date.now()],
    );
  });
};

const writeDryRun = (planInput: MigrationInput): void => {
  const plan = planMigration(planInput);
  const neverWiden = verifyPolicyRewriteNeverWidens(plan, planInput);
  mkdirSync(outputDir, { recursive: true });
  for (const org of plan.orgs) {
    writeFileSync(`${outputDir}/org-${org.tenantHash}.md`, renderOrgDiff(org));
  }
  writeFileSync(
    `${outputDir}/summary.md`,
    `${renderSummary(plan)}\npolicy_never_widen=${neverWiden.ok}\npolicy_never_widen_checked=${neverWiden.checkedPolicies}\n`,
  );
  console.log(renderSummary(plan));
  console.log(`policy_never_widen=${neverWiden.ok}`);
  console.log(`policy_never_widen_checked=${neverWiden.checkedPolicies}`);
  console.log(`diff_dir=${outputDir}`);
  if (!neverWiden.ok) {
    throw new Error(`Policy rewrite widened ${neverWiden.widened.length} policy row(s)`);
  }
};

const main = async (): Promise<void> => {
  if (inputJson) {
    const input = parseInputJson(inputJson);
    writeDryRun({ ...input, trafficLastTenant: trafficLastTenant ?? input.trafficLastTenant });
    return;
  }
  if (!databaseUrl) {
    throw new Error("Set DATABASE_URL or pass --input-json");
  }
  const usesLocalDatabase = databaseUrl.includes("127.0.0.1") || databaseUrl.includes("localhost");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
  }) as unknown as SqlClient;
  try {
    const input = await readDatabaseInput(sql, !apply);
    const plan = planMigration(input);
    if (!apply) {
      writeDryRun(input);
      return;
    }
    const neverWiden = verifyPolicyRewriteNeverWidens(plan, input);
    if (!neverWiden.ok) {
      throw new Error(`Policy rewrite widened ${neverWiden.widened.length} policy row(s)`);
    }
    for (const org of plan.orgs) {
      await applyOrg(sql, org);
      console.log(`applied_org=${tenantHash(org.tenant)}`);
    }
    console.log(renderSummary(plan));
  } finally {
    await sql.end({ timeout: 0 });
  }
};

await main();
