import { Data, Effect, Schema } from "effect";

import type { GitHubCustomToolsSourceSummary, GitHubSyncResult } from "../api";
import { parseGitHubSourceUrl } from "../source/github-url";

export const CUSTOM_TOOLS_PLUGIN_KEY = "apps";
export const CUSTOM_TOOLS_LABEL = "Custom tools";

export interface GitHubSourcesListResponse {
  readonly sources: readonly GitHubCustomToolsSourceSummary[];
}

export interface SyncGitHubSourceRequest {
  readonly url: string;
  readonly ref?: string;
  readonly token?: string;
}

export type CustomToolsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CustomToolsClientError extends Data.TaggedError("CustomToolsClientError")<{
  readonly message: string;
}> {}

export { parseGitHubSourceUrl };

export const validateGitHubSourceUrl = (url: string): string | null => {
  const parsed = parseGitHubSourceUrl(url);
  return parsed.ok ? null : parsed.message;
};

export const validateGitHubRepo = validateGitHubSourceUrl;

const decodeJsonText = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const responseErrorMessage = (body: unknown, fallback: string): string =>
  isRecord(body) && typeof body.error === "string" ? body.error : fallback;

const parseJsonResponseEffect = <A>(
  response: Response,
  fallback: string,
): Effect.Effect<A, CustomToolsClientError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new CustomToolsClientError({ message: fallback }),
    });
    const body =
      text.length > 0
        ? yield* decodeJsonText(text).pipe(
            Effect.mapError(() => new CustomToolsClientError({ message: fallback })),
          )
        : null;
    if (!response.ok) {
      return yield* new CustomToolsClientError({
        message: responseErrorMessage(body, fallback),
      });
    }
    return body as A;
  });

export const listCustomToolSourcesEffect = (
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<GitHubSourcesListResponse, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl("/api/apps/sources/github", {
        credentials: "same-origin",
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to load custom tools." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<GitHubSourcesListResponse>(response, "Failed to load custom tools."),
    ),
  );

export const listCustomToolSources = (
  fetchImpl: CustomToolsFetch = fetch,
): Promise<GitHubSourcesListResponse> => Effect.runPromise(listCustomToolSourcesEffect(fetchImpl));

export const syncCustomToolSourceEffect = (
  input: SyncGitHubSourceRequest,
  fetchImpl: CustomToolsFetch = fetch,
): Effect.Effect<GitHubSyncResult, CustomToolsClientError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl("/api/apps/sources/github/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          url: input.url.trim(),
          ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
          ...(input.token?.trim() ? { token: input.token.trim() } : {}),
        }),
      }),
    catch: () => new CustomToolsClientError({ message: "Failed to sync custom tools." }),
  }).pipe(
    Effect.flatMap((response) =>
      parseJsonResponseEffect<GitHubSyncResult>(response, "Failed to sync custom tools."),
    ),
  );

export const syncCustomToolSource = (
  input: SyncGitHubSourceRequest,
  fetchImpl: CustomToolsFetch = fetch,
): Promise<GitHubSyncResult> => Effect.runPromise(syncCustomToolSourceEffect(input, fetchImpl));

export const syncStatusLabel = (result: GitHubSyncResult): string => {
  if (result.status === "published") return `Published ${result.tools.length} tools.`;
  if (result.status === "up-to-date") return "Already up to date.";
  return "Sync failed.";
};

export const formatSyncErrors = (result: GitHubSyncResult): readonly string[] => {
  if (result.status !== "failed") return [];
  return result.errors.map((entry) => {
    const message = entry.message;
    const stage = entry.stage;
    const details = entry.diagnostics?.map((d) => `${d.path}: ${d.message}`).join("; ");
    return details ? `${stage}: ${message} (${details})` : `${stage}: ${message}`;
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
