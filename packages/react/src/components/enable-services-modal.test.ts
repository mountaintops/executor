import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderKey,
  type Connection,
} from "@executor-js/sdk/shared";

import type { ProviderAccount } from "../lib/provider-accounts";
import {
  activeEnableServiceStep,
  applyEnableServiceStepResult,
  buildEnableServiceOAuthStartPayload,
  createEnableServicesQueue,
  retryEnableServiceStep,
  type EnableServiceIntegration,
} from "./enable-services-modal";
import type { OAuthStartPayload } from "../plugins/oauth-sign-in";

const service = (
  slug: string,
  name: string,
  template = `${slug}_oauth`,
): EnableServiceIntegration => ({
  slug: IntegrationSlug.make(slug),
  name,
  kind: "google",
  authMethods: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      template,
    },
  ],
});

const gmail = service("google_gmail", "Gmail", "gmail_oauth");
const calendar = service("google_calendar", "Google Calendar", "calendar_oauth");
const drive = service("google_drive", "Google Drive", "drive_oauth");

const connection = (input?: { readonly oauthClientOwner?: "org" | "user" | null }): Connection => ({
  owner: "user",
  name: ConnectionName.make("gmail"),
  integration: IntegrationSlug.make("google_gmail"),
  template: AuthTemplateSlug.make("gmail_oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.google_gmail.user.gmail"),
  identityLabel: "user@example.com",
  description: null,
  expiresAt: null,
  oauthClient: OAuthClientSlug.make("google-app"),
  oauthClientOwner: input && "oauthClientOwner" in input ? input.oauthClientOwner : "org",
  oauthScope: null,
  lastHealth: null,
});

const account = (input?: {
  readonly label?: string;
  readonly oauthClientOwner?: "org" | "user" | null;
}): ProviderAccount<Connection, EnableServiceIntegration> => ({
  family: "google",
  owner: "user",
  identityKey: "user:google:user@example.com",
  label: input?.label ?? "user@example.com",
  connections: [{ connection: connection(input), integration: gmail }],
});

describe("enable services queue", () => {
  it("advances on success, keeps the remainder on failure, and retries", () => {
    let queue = createEnableServicesQueue([gmail, calendar, drive]);
    expect(activeEnableServiceStep(queue)?.integration.slug).toBe(gmail.slug);

    queue = applyEnableServiceStepResult(queue, gmail.slug, "done");
    expect(activeEnableServiceStep(queue)?.integration.slug).toBe(calendar.slug);

    queue = applyEnableServiceStepResult(queue, calendar.slug, "failed");
    expect(activeEnableServiceStep(queue)?.integration.slug).toBe(calendar.slug);
    expect(queue.steps.map((step) => [String(step.integration.slug), step.status])).toEqual([
      ["google_gmail", "done"],
      ["google_calendar", "failed"],
      ["google_drive", "pending"],
    ]);

    queue = retryEnableServiceStep(queue, calendar.slug);
    expect(activeEnableServiceStep(queue)?.integration.slug).toBe(calendar.slug);
    expect(queue.steps[1]?.status).toBe("pending");

    queue = applyEnableServiceStepResult(queue, calendar.slug, "done");
    expect(activeEnableServiceStep(queue)?.integration.slug).toBe(drive.slug);
  });
});

describe("buildEnableServiceOAuthStartPayload", () => {
  it("builds the startOAuth payload with loginHint, mirrored client, and service template", () => {
    const calls: OAuthStartPayload[] = [];
    const startOAuth = (payload: OAuthStartPayload) => calls.push(payload);
    const payload = buildEnableServiceOAuthStartPayload({
      account: account(),
      integration: calendar,
      organizationId: "org_123",
    });

    expect(payload).not.toBeNull();
    startOAuth(payload!);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      client: OAuthClientSlug.make("google-app"),
      clientOwner: "org",
      owner: "user",
      name: ConnectionName.make("userGoogleCalendar"),
      integration: IntegrationSlug.make("google_calendar"),
      template: AuthTemplateSlug.make("calendar_oauth"),
      identityLabel: "user Google Calendar",
      loginHint: "user@example.com",
    });
  });

  it("derives distinct names for two same-owner accounts enabling the same service", () => {
    const first = buildEnableServiceOAuthStartPayload({
      account: account({ label: "rhys@example.com" }),
      integration: calendar,
      organizationId: "org_123",
    });
    const second = buildEnableServiceOAuthStartPayload({
      account: account({ label: "work@example.com" }),
      integration: calendar,
      organizationId: "org_123",
    });

    expect(first?.name).toBe(ConnectionName.make("rhysGoogleCalendar"));
    expect(second?.name).toBe(ConnectionName.make("workGoogleCalendar"));
    expect(first?.identityLabel).toBe("rhys Google Calendar");
    expect(second?.identityLabel).toBe("work Google Calendar");
    expect(first?.name).not.toBe(second?.name);
  });

  it("uses the connection owner when the existing connection has no client owner", () => {
    const payload = buildEnableServiceOAuthStartPayload({
      account: account({ oauthClientOwner: null }),
      integration: drive,
      organizationId: "org_123",
    });

    expect(payload?.clientOwner).toBe("user");
  });

  it("does not build a payload without an email account label", () => {
    expect(
      buildEnableServiceOAuthStartPayload({
        account: account({ label: "Personal Google" }),
        integration: calendar,
        organizationId: "org_123",
      }),
    ).toBeNull();
  });
});
