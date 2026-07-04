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
  continueEnableServiceStep,
  createEnableServicesQueue,
  EnableServicesModal,
  retryEnableServiceStep,
  type EnableServiceIntegration,
  type EnableServiceQueue,
  type EnableServiceStepStatus,
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

describe("continueEnableServiceStep", () => {
  /** Drives the queue exactly like EnableServicesModalBody: `continueStep`
   *  mirrors handleContinue (Continue click), and step completion flows back
   *  through markActive, so the opener-call count is observable per click. */
  const harness = () => {
    let queue: EnableServiceQueue<EnableServiceIntegration> = createEnableServicesQueue([
      gmail,
      calendar,
    ]);
    const started: {
      readonly payload: OAuthStartPayload;
      readonly onSuccess: () => void;
      readonly onError: () => void;
    }[] = [];
    const markActive = (status: EnableServiceStepStatus) => {
      const active = activeEnableServiceStep(queue);
      if (active) queue = applyEnableServiceStepResult(queue, active.integration.slug, status);
    };
    const continueStep = () => {
      const active = activeEnableServiceStep(queue);
      if (!active) return;
      continueEnableServiceStep({
        account: account(),
        integration: active.integration,
        organizationId: "org_123",
        start: (input) => started.push(input),
        markActive,
      });
    };
    return {
      started,
      continueStep,
      queue: () => queue,
    };
  };

  it("opens exactly one popup per Continue click and never auto-chains on success", () => {
    const { started, continueStep, queue } = harness();

    continueStep();
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.integration).toBe(gmail.slug);

    // The popup completes: the step is marked done and the queue advances,
    // but no second popup opens without a fresh Continue click.
    started[0]!.onSuccess();
    expect(queue().steps[0]?.status).toBe("done");
    expect(activeEnableServiceStep(queue())?.integration.slug).toBe(calendar.slug);
    expect(started).toHaveLength(1);

    continueStep();
    expect(started).toHaveLength(2);
    expect(started[1]?.payload.integration).toBe(calendar.slug);
  });

  it("does not auto-retry or auto-advance when a step fails", () => {
    const { started, continueStep, queue } = harness();

    continueStep();
    started[0]!.onError();
    expect(queue().steps[0]?.status).toBe("failed");
    expect(activeEnableServiceStep(queue())?.integration.slug).toBe(gmail.slug);
    expect(started).toHaveLength(1);
  });

  it("marks the step failed without opening a popup when no payload can be built", () => {
    const started: OAuthStartPayload[] = [];
    const statuses: EnableServiceStepStatus[] = [];
    continueEnableServiceStep({
      account: account({ label: "Personal Google" }),
      integration: calendar,
      organizationId: "org_123",
      start: (input) => started.push(input.payload),
      markActive: (status) => statuses.push(status),
    });
    expect(started).toHaveLength(0);
    expect(statuses).toEqual(["failed"]);
  });
});

describe("EnableServicesModal mount boundary", () => {
  // The wrapper renders nothing while closed, so the body (and with it the
  // useOAuthPopupFlow instance owning the in-flight popup) unmounts on close;
  // the hook's unmount effect cancels the session. The wrapper has no hooks,
  // so calling it as a plain function is safe here.
  const wrapperProps = {
    integrations: [gmail, calendar],
    onOpenChange: () => {},
  };

  it("renders nothing when closed, unmounting the body and its OAuth flow", () => {
    expect(EnableServicesModal({ ...wrapperProps, open: false, account: account() })).toBeNull();
  });

  it("renders nothing without an account", () => {
    expect(EnableServicesModal({ ...wrapperProps, open: true, account: null })).toBeNull();
  });

  it("mounts the body only while open with an account", () => {
    expect(EnableServicesModal({ ...wrapperProps, open: true, account: account() })).not.toBeNull();
  });
});
