import type { Connection } from "@executor-js/sdk/shared";

import type { GitHubCustomToolsSourceSummary, GitHubSyncResult } from "../api";

export const CUSTOM_TOOLS_PLUGIN_KEY = "apps";
export const CUSTOM_TOOLS_LABEL = "Custom tools";

export interface GitHubSourcesListResponse {
  readonly sources: readonly GitHubCustomToolsSourceSummary[];
}

export interface SyncGitHubSourceRequest {
  readonly repo: string;
  readonly ref?: string;
  readonly connection: string;
}

export class CustomToolsClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomToolsClientError";
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const validateGitHubRepo = (repo: string): string | null => {
  const trimmed = repo.trim();
  if (trimmed.length === 0) return "Enter a GitHub repo.";
  if (!REPO_RE.test(trimmed)) return "Use owner/name, for example UsefulSoftwareCo/executor.";
  return null;
};

export const githubConnections = (connections: readonly Connection[]): readonly Connection[] =>
  connections.filter((connection) => String(connection.integration) === "github");

const parseJsonResponse = async <A>(response: Response, fallback: string): Promise<A> => {
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : fallback;
    throw new CustomToolsClientError(message);
  }
  return body as A;
};

export const listCustomToolSources = async (
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubSourcesListResponse> => {
  const response = await fetchImpl("/api/apps/sources/github", {
    credentials: "same-origin",
  });
  return parseJsonResponse<GitHubSourcesListResponse>(response, "Failed to load custom tools.");
};

export const syncCustomToolSource = async (
  input: SyncGitHubSourceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubSyncResult> => {
  const response = await fetchImpl("/api/apps/sources/github/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      repo: input.repo.trim(),
      ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
      connection: input.connection,
    }),
  });
  return parseJsonResponse<GitHubSyncResult>(response, "Failed to sync custom tools.");
};

export const syncStatusLabel = (result: GitHubSyncResult): string => {
  if (result.status === "published") return `Published ${result.tools.length} tools.`;
  if (result.status === "up-to-date") return "Already up to date.";
  return "Sync failed.";
};

export const formatSyncErrors = (result: GitHubSyncResult): readonly string[] => {
  if (result.status !== "failed") return [];
  return result.errors.map((error) => {
    const details = error.diagnostics?.map((d) => `${d.path}: ${d.message}`).join("; ");
    return details
      ? `${error.stage}: ${error.message} (${details})`
      : `${error.stage}: ${error.message}`;
  });
};

export const toolDiff = (
  before: readonly string[],
  after: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } => {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((tool) => !beforeSet.has(tool)),
    removed: before.filter((tool) => !afterSet.has(tool)),
  };
};

export const consoleIntegrationHref = (path: string): string => {
  if (typeof window === "undefined") return path;
  const marker = "/integrations";
  const index = window.location.pathname.indexOf(marker);
  const prefix = index === -1 ? "" : window.location.pathname.slice(0, index);
  return `${prefix}${path}`;
};
