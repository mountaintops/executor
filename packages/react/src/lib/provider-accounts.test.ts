import { describe, expect, it } from "@effect/vitest";

import { groupProviderAccounts, normalizeEmail } from "./provider-accounts";

type TestConnection = {
  readonly owner: "org" | "user";
  readonly name: string;
  readonly integration: string;
  readonly identityLabel?: string | null;
};

type TestIntegration = {
  readonly slug: string;
  readonly kind: string;
  readonly name: string;
};

const integration = (slug: string, kind: string): TestIntegration => ({
  slug,
  kind,
  name: slug,
});

const connection = (input: TestConnection): TestConnection => input;

const integrations = new Map<string, TestIntegration>([
  ["google_calendar", integration("google_calendar", "google")],
  ["google_gmail", integration("google_gmail", "google")],
  ["microsoft_mail", integration("microsoft_mail", "microsoft")],
  ["microsoft_calendar", integration("microsoft_calendar", "microsoft")],
  ["github_issues", integration("github_issues", "github")],
  ["github_prs", integration("github_prs", "github")],
]);

const memberships = (
  accounts: ReturnType<typeof groupProviderAccounts<TestConnection, TestIntegration>>,
) =>
  accounts.map((account) => ({
    identityKey: account.identityKey,
    connections: account.connections.map((entry) => entry.connection.name),
  }));

describe("normalizeEmail", () => {
  it("trims, lowercases, and rejects non-email labels", () => {
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("groupProviderAccounts", () => {
  it("groups Google services with the same email into one account", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "gmail",
          integration: "google_gmail",
          identityLabel: "User@Example.com",
        }),
        connection({
          owner: "user",
          name: "calendar",
          integration: "google_calendar",
          identityLabel: " user@example.com ",
        }),
      ],
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.identityKey).toBe("user:google:user@example.com");
    expect(accounts[0]?.label).toBe("user@example.com");
    expect(accounts[0]?.connections.map((entry) => entry.connection.name)).toEqual([
      "calendar",
      "gmail",
    ]);
  });

  it("keeps different Google emails as separate accounts", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "work",
          integration: "google_gmail",
          identityLabel: "work@example.com",
        }),
        connection({
          owner: "user",
          name: "personal",
          integration: "google_calendar",
          identityLabel: "me@example.com",
        }),
      ],
    });

    expect(memberships(accounts)).toEqual([
      { identityKey: "user:google:me@example.com", connections: ["personal"] },
      { identityKey: "user:google:work@example.com", connections: ["work"] },
    ]);
  });

  it("keeps Microsoft in a separate family from Google", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "google",
          integration: "google_gmail",
          identityLabel: "user@example.com",
        }),
        connection({
          owner: "user",
          name: "microsoft",
          integration: "microsoft_mail",
          identityLabel: "user@example.com",
        }),
      ],
    });

    expect(memberships(accounts)).toEqual([
      { identityKey: "user:google:user@example.com", connections: ["google"] },
      { identityKey: "user:microsoft:user@example.com", connections: ["microsoft"] },
    ]);
  });

  it("does not merge non-family integrations", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "issues",
          integration: "github_issues",
          identityLabel: "user@example.com",
        }),
        connection({
          owner: "user",
          name: "prs",
          integration: "github_prs",
          identityLabel: "user@example.com",
        }),
      ],
    });

    expect(memberships(accounts)).toEqual([
      { identityKey: "user:github:github_issues:issues", connections: ["issues"] },
      { identityKey: "user:github:github_prs:prs", connections: ["prs"] },
    ]);
  });

  it("keeps organization and user owners separate", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "org",
          name: "workspace",
          integration: "google_gmail",
          identityLabel: "user@example.com",
        }),
        connection({
          owner: "user",
          name: "personal",
          integration: "google_calendar",
          identityLabel: "user@example.com",
        }),
      ],
    });

    expect(memberships(accounts)).toEqual([
      { identityKey: "org:google:user@example.com", connections: ["workspace"] },
      { identityKey: "user:google:user@example.com", connections: ["personal"] },
    ]);
  });

  it("keeps null or non-email identity labels as singleton accounts", () => {
    const accounts = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "gmail",
          integration: "google_gmail",
          identityLabel: null,
        }),
        connection({
          owner: "user",
          name: "calendar",
          integration: "google_calendar",
          identityLabel: "Personal Google",
        }),
      ],
    });

    expect(memberships(accounts)).toEqual([
      { identityKey: "user:google:google_calendar:calendar", connections: ["calendar"] },
      { identityKey: "user:google:google_gmail:gmail", connections: ["gmail"] },
    ]);
  });

  it("regroups deterministically when a label changes to a matching email", () => {
    const before = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "calendar",
          integration: "google_calendar",
          identityLabel: "old@example.com",
        }),
        connection({
          owner: "user",
          name: "gmail",
          integration: "google_gmail",
          identityLabel: "user@example.com",
        }),
      ],
    });
    const after = groupProviderAccounts({
      integrationsByKind: integrations,
      connections: [
        connection({
          owner: "user",
          name: "calendar",
          integration: "google_calendar",
          identityLabel: " USER@example.com ",
        }),
        connection({
          owner: "user",
          name: "gmail",
          integration: "google_gmail",
          identityLabel: "user@example.com",
        }),
      ],
    });

    expect(memberships(before)).toEqual([
      { identityKey: "user:google:old@example.com", connections: ["calendar"] },
      { identityKey: "user:google:user@example.com", connections: ["gmail"] },
    ]);
    expect(memberships(after)).toEqual([
      { identityKey: "user:google:user@example.com", connections: ["calendar", "gmail"] },
    ]);
  });
});
