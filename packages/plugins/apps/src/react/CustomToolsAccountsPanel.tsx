import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";

import type { GitHubCustomToolsSourceSummary, GitHubSyncResult } from "../api";
import {
  consoleIntegrationHref,
  formatSyncErrors,
  listCustomToolSources,
  syncCustomToolSource,
  syncStatusLabel,
  toolDiff,
} from "./custom-tools-client";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sources: readonly GitHubCustomToolsSourceSummary[] };

interface SyncNotice {
  readonly status: GitHubSyncResult["status"];
  readonly message: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: readonly string[];
}

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export default function CustomToolsAccountsPanel() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  const [notice, setNotice] = useState<SyncNotice | null>(null);

  const loadSources = async () => {
    setLoadState({ status: "loading" });
    try {
      const result = await listCustomToolSources();
      setLoadState({ status: "ready", sources: result.sources });
      setSelectedScope((current) => current ?? result.sources[0]?.scope ?? null);
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load custom tool sources.",
      });
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await listCustomToolSources();
        if (!active) return;
        setLoadState({ status: "ready", sources: result.sources });
        setSelectedScope(result.sources[0]?.scope ?? null);
      } catch (error) {
        if (!active) return;
        setLoadState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load custom tool sources.",
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const sources = loadState.status === "ready" ? loadState.sources : [];
  const selected = useMemo(
    () => sources.find((source) => source.scope === selectedScope) ?? sources[0] ?? null,
    [sources, selectedScope],
  );

  const syncSelected = async (source: GitHubCustomToolsSourceSummary) => {
    if (!source.connection) {
      setNotice({
        status: "failed",
        message: "Sync failed.",
        added: [],
        removed: [],
        errors: ["This source does not have a recorded GitHub connection."],
      });
      return;
    }
    setSyncingScope(source.scope);
    setNotice(null);
    const beforeTools = source.tools;
    try {
      const result = await syncCustomToolSource({
        repo: source.repo,
        ref: source.ref,
        connection: source.connection,
      });
      const diff =
        result.status === "failed"
          ? { added: [], removed: [] }
          : toolDiff(beforeTools, result.tools);
      setNotice({
        status: result.status,
        message: syncStatusLabel(result),
        added: diff.added,
        removed: diff.removed,
        errors: formatSyncErrors(result),
      });
      if (result.status !== "failed") {
        await loadSources();
        setSelectedScope(source.scope);
      }
    } catch (error) {
      setNotice({
        status: "failed",
        message: "Sync failed.",
        added: [],
        removed: [],
        errors: [error instanceof Error ? error.message : "Failed to sync custom tools."],
      });
    }
    setSyncingScope(null);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Custom tools sources</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            GitHub repositories synced into the executor tool catalog.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={consoleIntegrationHref("/integrations/add/apps")}>Add source</a>
        </Button>
      </div>

      {loadState.status === "loading" && (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Loading sources...
        </div>
      )}

      {loadState.status === "error" && (
        <ErrorWithRetry message={loadState.message} onRetry={() => void loadSources()} />
      )}

      {loadState.status === "ready" && sources.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium text-foreground">No custom tools sources</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a GitHub repo to publish its tools.
          </p>
          <Button asChild size="sm" className="mt-4">
            <a href={consoleIntegrationHref("/integrations/add/apps")}>Add source</a>
          </Button>
        </div>
      )}

      {loadState.status === "ready" && sources.length > 0 && (
        <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[18rem_1fr]">
          <CardStack searchable>
            <CardStackContent>
              {sources.map((source) => (
                <CardStackEntry
                  key={source.scope}
                  asChild
                  searchText={`${source.repo} ${source.ref}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedScope(source.scope);
                      setNotice(null);
                    }}
                    className={
                      selected?.scope === source.scope
                        ? "bg-muted/70 text-left"
                        : "bg-transparent text-left"
                    }
                  >
                    <CardStackEntryContent>
                      <CardStackEntryTitle>{source.repo}</CardStackEntryTitle>
                      <CardStackEntryDescription>{source.ref}</CardStackEntryDescription>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Badge variant="secondary">{source.tools.length}</Badge>
                    </CardStackEntryActions>
                  </button>
                </CardStackEntry>
              ))}
            </CardStackContent>
          </CardStack>

          {selected && (
            <SourceDetail
              source={selected}
              notice={notice}
              syncing={syncingScope === selected.scope}
              onSync={() => void syncSelected(selected)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ErrorWithRetry(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Failed to load sources</AlertTitle>
      <AlertDescription>
        <div className="space-y-3">
          <p>{props.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function SourceDetail(props: {
  readonly source: GitHubCustomToolsSourceSummary;
  readonly notice: SyncNotice | null;
  readonly syncing: boolean;
  readonly onSync: () => void;
}) {
  const { source, notice } = props;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{source.repo}</h3>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{source.scope}</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={props.onSync}
          loading={props.syncing}
          disabled={!source.connection}
        >
          Sync
        </Button>
      </div>

      <div className="space-y-6 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="Ref" value={source.ref} />
          <Field label="Upstream SHA" value={source.upstreamSha} mono />
          <Field label="Last synced" value={formatDate(source.publishedAt)} />
          <Field label="GitHub connection" value={source.connection ?? "Not recorded"} mono />
        </dl>

        {notice && (
          <Alert variant={notice.status === "failed" ? "destructive" : "default"}>
            <AlertTitle>{notice.message}</AlertTitle>
            {(notice.added.length > 0 || notice.removed.length > 0 || notice.errors.length > 0) && (
              <AlertDescription>
                <div className="space-y-1">
                  {notice.added.length > 0 && <p>Added: {notice.added.join(", ")}</p>}
                  {notice.removed.length > 0 && <p>Removed: {notice.removed.join(", ")}</p>}
                  {notice.errors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                </div>
              </AlertDescription>
            )}
          </Alert>
        )}

        <Section title="Published tools">
          {source.tools.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {source.tools.map((tool) => (
                <Badge key={tool} variant="secondary">
                  {tool}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tools published.</p>
          )}
        </Section>

        <Section title="Skipped entries">
          {source.skipped.length > 0 ? (
            <div className="divide-y divide-border rounded-md border border-border">
              {source.skipped.map((entry) => (
                <div key={`${entry.path}:${entry.reason}`} className="flex gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {entry.path}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{entry.reason}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing skipped.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Field(props: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{props.label}</dt>
      <dd
        className={`mt-1 truncate text-sm text-foreground ${props.mono ? "font-mono text-xs" : ""}`}
      >
        {props.value}
      </dd>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">{props.title}</h4>
      {props.children}
    </section>
  );
}
