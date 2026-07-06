import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Exit from "effect/Exit";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";

import {
  MicrosoftWorkloadResultPanel,
  microsoftAddWorkloadsPayload,
  submitMicrosoftWorkloadsSelection,
  type AddMicrosoftWorkloadsMutation,
} from "./AddMicrosoftSource";
import type { MicrosoftAddWorkloadsResult } from "../sdk/plugin";

type TestElementProps = {
  readonly children?: ReactNode;
  readonly onClick?: (event?: unknown) => void;
};

const collectText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (React.isValidElement<TestElementProps>(node)) return collectText(node.props.children);
  return "";
};

const findElementWithText = (
  node: ReactNode,
  text: string,
): ReactElement<TestElementProps> | null => {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementWithText(child, text);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement<TestElementProps>(node)) return null;
  if (collectText(node.props.children).trim() === text) return node;
  return findElementWithText(node.props.children, text);
};

const emptyResult: MicrosoftAddWorkloadsResult = {
  added: [],
  skipped: [],
  failed: [],
};

describe("AddMicrosoftSource per-workload submit", () => {
  it("submits three checked presets in one addWorkloads call", async () => {
    const calls: Parameters<AddMicrosoftWorkloadsMutation>[0][] = [];
    const addWorkloads: AddMicrosoftWorkloadsMutation = (input) => {
      calls.push(input);
      return Promise.resolve(Exit.succeed(emptyResult));
    };

    await submitMicrosoftWorkloadsSelection(addWorkloads, {
      presetIds: ["mail", "calendar", "files"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      workloads: [{ presetId: "mail" }, { presetId: "calendar" }, { presetId: "files" }],
    });
  });

  it("renders added, skipped, and failed result rows", () => {
    const result: MicrosoftAddWorkloadsResult = {
      added: [
        {
          slug: IntegrationSlug.make("microsoft_mail"),
          presetId: "mail",
          toolCount: 14,
        },
      ],
      skipped: [
        {
          slug: IntegrationSlug.make("microsoft_calendar"),
          presetId: "calendar",
          reason: "already_exists",
        },
      ],
      failed: [
        {
          slug: IntegrationSlug.make("microsoft_files"),
          presetId: "files",
          error: "Graph spec failed",
        },
        {
          slug: IntegrationSlug.make("microsoft_graph_custom"),
          presetId: "custom",
          error: "Custom Graph scope failed",
        },
      ],
    };

    const text = collectText(
      MicrosoftWorkloadResultPanel({
        result,
        retryingPresetId: null,
        onRetry: () => {},
      }),
    );

    expect(text).toContain("Outlook Mail");
    expect(text).toContain("Added");
    expect(text).toContain("Outlook Calendar");
    expect(text).toContain("Already exists");
    expect(text).toContain("OneDrive Files");
    expect(text).toContain("Graph spec failed");
    expect(text).toContain("Custom Graph scopes");
    expect(text).toContain("Custom Graph scope failed");
    expect(text).toContain("Retry");
  });

  it("retry re-submits only the failed presetId", async () => {
    let retryPresetId: string | null = null;
    const result: MicrosoftAddWorkloadsResult = {
      added: [],
      skipped: [],
      failed: [
        {
          slug: IntegrationSlug.make("microsoft_files"),
          presetId: "files",
          error: "Graph spec failed",
        },
      ],
    };
    const retry = findElementWithText(
      MicrosoftWorkloadResultPanel({
        result,
        retryingPresetId: null,
        onRetry: (presetId: string) => {
          retryPresetId = presetId;
        },
      }),
      "Retry",
    );

    retry?.props.onClick?.();

    const calls: Parameters<AddMicrosoftWorkloadsMutation>[0][] = [];
    const addWorkloads: AddMicrosoftWorkloadsMutation = (input) => {
      calls.push(input);
      return Promise.resolve(Exit.succeed(emptyResult));
    };
    await submitMicrosoftWorkloadsSelection(addWorkloads, {
      presetIds: retryPresetId ? [retryPresetId] : [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      workloads: [{ presetId: "files" }],
    });
  });

  it("passes name and slug overrides for a single selected workload", () => {
    expect(
      microsoftAddWorkloadsPayload({
        presetIds: ["mail"],
        identityOverride: {
          slug: "team_mail",
          name: "Team Mail",
        },
      }),
    ).toEqual({
      workloads: [
        {
          presetId: "mail",
          slug: "team_mail",
          name: "Team Mail",
        },
      ],
    });
  });

  it("mixed flow: the custom workload entry carries only custom scopes, never the fanned-out presets", () => {
    expect(
      microsoftAddWorkloadsPayload({
        presetIds: ["mail", "calendar"],
        custom: {
          customScopes: ["Sites.Read.All", "Custom.Scope"],
          slug: "microsoft_graph_custom",
          name: "Custom Microsoft Graph",
          description: "Custom Microsoft Graph scopes.",
        },
        baseUrl: " https://graph.microsoft.com/beta ",
      }),
    ).toEqual({
      workloads: [
        { presetId: "mail" },
        { presetId: "calendar" },
        {
          custom: {
            customScopes: ["Sites.Read.All", "Custom.Scope"],
            slug: "microsoft_graph_custom",
            name: "Custom Microsoft Graph",
            description: "Custom Microsoft Graph scopes.",
          },
        },
      ],
      baseUrl: "https://graph.microsoft.com/beta",
    });
  });
});
