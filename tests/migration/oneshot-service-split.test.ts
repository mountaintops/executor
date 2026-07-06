import { describe, expect, it } from "@effect/vitest";

import {
  planMigration,
  verifyPolicyRewriteNeverWidens,
  type ConnectionRow,
  type IntegrationRow,
  type MigrationInput,
  type ToolPolicyRow,
  type ToolRow,
} from "../../scripts/migration/oneshot-service-split";

const now = "2026-01-01T00:00:00.000Z";

const integration = (overrides: Partial<IntegrationRow> = {}): IntegrationRow => ({
  tenant: "org_1",
  slug: "google",
  plugin_id: "google",
  name: "Google",
  description: "Google APIs",
  config: {
    googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
    specHash: "mono-hash",
    authenticationTemplate: [{ slug: "googleOAuth", kind: "oauth2" }],
  },
  health_check: null,
  config_revised_at: null,
  can_remove: true,
  can_refresh: true,
  created_at: now,
  updated_at: now,
  row_id: "int_1",
  ...overrides,
});

const connection = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  integration: "google",
  name: "main",
  template: "googleOAuth",
  provider: "vault",
  item_ids: { access: "access_item", refresh: "refresh_item" },
  identity_label: "person@example.test",
  description: null,
  last_health: null,
  tools_synced_at: 1,
  oauth_client: "google",
  oauth_client_owner: "org",
  refresh_item_id: "refresh_item",
  expires_at: 2,
  oauth_scope: "calendar gmail",
  oauth_token_url: "https://oauth2.googleapis.com/token",
  provider_state: { token: "metadata" },
  created_at: now,
  updated_at: now,
  row_id: "conn_1",
  ...overrides,
});

const tool = (name: string, overrides: Partial<ToolRow> = {}): ToolRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  integration: "google",
  connection: "main",
  plugin_id: "google",
  name,
  description: "tool",
  input_schema: {},
  output_schema: {},
  annotations: {},
  created_at: now,
  updated_at: now,
  row_id: `tool_${name}`,
  ...overrides,
});

const policy = (pattern: string, overrides: Partial<ToolPolicyRow> = {}): ToolPolicyRow => ({
  tenant: "org_1",
  owner: "org",
  subject: "",
  id: `pol_${pattern.replaceAll(".", "_").replaceAll("*", "star")}`,
  pattern,
  action: "block",
  position: "a0",
  created_at: now,
  updated_at: now,
  row_id: `row_${pattern}`,
  ...overrides,
});

const input = (overrides: Partial<MigrationInput> = {}): MigrationInput => ({
  integrations: [integration()],
  connections: [connection()],
  tools: [tool("calendar.events.list")],
  policies: [],
  ...overrides,
});

describe("one-shot service split migration planner", () => {
  it("plans a single-service monolith split", () => {
    const plan = planMigration(input());

    expect(plan.summary.integrationsCreate).toBe(1);
    expect(plan.summary.connectionsClone).toBe(1);
    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual(["google_calendar"]);
    expect(plan.orgs[0]?.deleteMonoliths.map((row) => row.slug)).toEqual(["google"]);
  });

  it("plans a multi-service monolith split from stored Discovery URLs", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration({
            config: {
              googleDiscoveryUrls: [
                "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
                "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
              ],
            },
          }),
        ],
        tools: [tool("calendar.events.list"), tool("gmail.users.messages.send")],
      }),
    );

    expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual([
      "google_calendar",
      "google_gmail",
    ]);
    expect(plan.summary.connectionsClone).toBe(2);
  });

  it("fans out wildcard policies by matched service without widening inventory matches", () => {
    const migrationInput = input({
      integrations: [
        integration({
          config: {
            googleDiscoveryUrls: [
              "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
              "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
            ],
          },
        }),
      ],
      tools: [tool("calendar.events.delete"), tool("gmail.users.messages.delete")],
      policies: [policy("google.*")],
    });
    const plan = planMigration(migrationInput);

    expect(plan.orgs[0]?.policies[0]?.afterPatterns).toEqual([
      "google_calendar.*",
      "google_gmail.*",
    ]);
    expect(verifyPolicyRewriteNeverWidens(plan, migrationInput)).toMatchObject({
      ok: true,
      checkedPolicies: 1,
    });
  });

  it("skips openapi lookalike google slugs because plugin ownership is not google", () => {
    const plan = planMigration(
      input({
        integrations: [integration({ plugin_id: "openapi", slug: "google" })],
        tools: [tool("calendar.events.list", { plugin_id: "openapi" })],
        policies: [policy("google.*")],
      }),
    );

    expect(plan.summary.orgs).toBe(0);
    expect(plan.summary.policiesRewrite).toBe(0);
  });

  it("is idempotent when target integration and connection already exist", () => {
    const plan = planMigration(
      input({
        integrations: [
          integration(),
          integration({
            slug: "google_calendar",
            name: "Google Calendar",
            row_id: "int_calendar",
          }),
        ],
        connections: [
          connection(),
          connection({ integration: "google_calendar", row_id: "conn_calendar" }),
        ],
      }),
    );

    expect(plan.summary.integrationsCreate).toBe(0);
    expect(plan.summary.integrationsSkipExisting).toBe(1);
    expect(plan.summary.connectionsClone).toBe(0);
    expect(plan.summary.connectionsSkipExisting).toBe(1);
  });

  it("skips completed orgs for resume-after-partial", () => {
    const plan = planMigration(input({ completedTenants: ["org_1"] }));

    expect(plan.orgs[0]?.completed).toBe(true);
    expect(plan.summary.completedOrgs).toBe(1);
    expect(plan.summary.integrationsCreate).toBe(0);
    expect(plan.summary.monolithDeletes).toBe(0);
  });
});
