import type { GitHubCustomToolsSourceSummary, GitHubSyncResult } from "../api";
import {
  consoleIntegrationHref,
  formatSyncErrors,
  syncStatusLabel,
  toolDiff,
} from "./custom-tools-client";

export interface SourcePanelModel {
  readonly title: string;
  readonly repository: {
    readonly href: string;
    readonly label: string;
  };
  readonly lastSynced: string;
  readonly publishedTools: {
    readonly href: string;
    readonly label: string;
  };
}

export interface SyncNoticeModel {
  readonly status: GitHubSyncResult["status"];
  readonly message: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: readonly string[];
  readonly skipped: GitHubSyncResult["skipped"];
  readonly upstreamSha?: string;
}

export const formatRelativeSyncTime = (iso: string, now = Date.now()): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Math.max(0, now - then);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export const sourceRepositoryDisplay = (
  source: GitHubCustomToolsSourceSummary,
): SourcePanelModel["repository"] => {
  const explicitRef = /\/(tree|commit)\//.test(source.url);
  const base = `github.com/${source.repo}`;
  return {
    href: source.url,
    label: explicitRef ? `${base} @ ${source.ref}` : base,
  };
};

export const toolsCountLabel = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

export const sourcePanelModel = (
  source: GitHubCustomToolsSourceSummary,
  options?: { readonly now?: number },
): SourcePanelModel => ({
  title: source.name,
  repository: sourceRepositoryDisplay(source),
  lastSynced: `Last synced ${formatRelativeSyncTime(source.publishedAt, options?.now)}`,
  publishedTools: {
    href: consoleIntegrationHref(`/integrations/${encodeURIComponent(source.slug)}?tab=tools`),
    label: toolsCountLabel(source.tools.length),
  },
});

export const syncNoticeFromResult = (
  result: GitHubSyncResult,
  beforeTools: readonly string[],
): SyncNoticeModel => {
  const diff =
    result.status === "failed" ? { added: [], removed: [] } : toolDiff(beforeTools, result.tools);
  return {
    status: result.status,
    message: syncStatusLabel(result),
    added: diff.added,
    removed: diff.removed,
    errors: formatSyncErrors(result),
    skipped: result.skipped,
    ...(result.upstreamSha ? { upstreamSha: result.upstreamSha } : {}),
  };
};
