import { useEffect, useState, type ReactNode } from "react";
import { Effect, Exit } from "effect";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@executor-js/react/components/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";

import type { GitHubCustomToolsSourceSummary, GitHubSyncResult } from "../api";
import {
  consoleIntegrationHref,
  formatSyncErrors,
  getCustomToolSourceEffect,
  removeCustomToolSourceEffect,
  syncCustomToolSourceEffect,
  syncStatusLabel,
  toolDiff,
} from "./custom-tools-client";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly source: GitHubCustomToolsSourceSummary };

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

export default function CustomToolsAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<SyncNotice | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadSource = async () => {
    setLoadState({ status: "loading" });
    const exit = await Effect.runPromiseExit(getCustomToolSourceEffect(props.sourceId));
    if (Exit.isFailure(exit)) {
      setLoadState({ status: "error", message: "Failed to load custom tools source." });
      return;
    }
    const source = exit.value.source;
    setLoadState(source ? { status: "ready", source } : { status: "missing" });
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const exit = await Effect.runPromiseExit(getCustomToolSourceEffect(props.sourceId));
      if (!active) return;
      if (Exit.isFailure(exit)) {
        setLoadState({ status: "error", message: "Failed to load custom tools source." });
        return;
      }
      const source = exit.value.source;
      setLoadState(source ? { status: "ready", source } : { status: "missing" });
    })();
    return () => {
      active = false;
    };
  }, [props.sourceId]);

  const syncSource = async (source: GitHubCustomToolsSourceSummary) => {
    setSyncing(true);
    setNotice(null);
    const beforeTools = source.tools;
    const exit = await Effect.runPromiseExit(syncCustomToolSourceEffect({ slug: source.slug }));
    if (Exit.isFailure(exit)) {
      setNotice({
        status: "failed",
        message: "Sync failed.",
        added: [],
        removed: [],
        errors: ["Failed to sync custom tools."],
      });
      setSyncing(false);
      return;
    }
    const result = exit.value;
    const diff =
      result.status === "failed" ? { added: [], removed: [] } : toolDiff(beforeTools, result.tools);
    setNotice({
      status: result.status,
      message: syncStatusLabel(result),
      added: diff.added,
      removed: diff.removed,
      errors: formatSyncErrors(result),
    });
    if (result.status !== "failed") await loadSource();
    setSyncing(false);
  };

  const removeSource = async (source: GitHubCustomToolsSourceSummary) => {
    setRemoving(true);
    setRemoveError(null);
    const exit = await Effect.runPromiseExit(removeCustomToolSourceEffect(source.slug));
    if (Exit.isFailure(exit)) {
      setRemoveError("Failed to remove custom tools source.");
      setRemoving(false);
      return;
    }
    window.location.assign(consoleIntegrationHref("/integrations"));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      {loadState.status === "loading" && (
        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Loading source...
        </div>
      )}

      {loadState.status === "error" && (
        <ErrorWithRetry message={loadState.message} onRetry={() => void loadSource()} />
      )}

      {loadState.status === "missing" && (
        <Alert variant="destructive">
          <AlertTitle>Source not found</AlertTitle>
          <AlertDescription>
            The custom tools source for {props.integrationName} is no longer available.
          </AlertDescription>
        </Alert>
      )}

      {loadState.status === "ready" && (
        <SourceDetail
          source={loadState.source}
          notice={notice}
          removeError={removeError}
          syncing={syncing}
          removing={removing}
          onSync={() => void syncSource(loadState.source)}
          onRemove={() => void removeSource(loadState.source)}
        />
      )}
    </div>
  );
}

function ErrorWithRetry(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Failed to load source</AlertTitle>
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
  readonly removeError: string | null;
  readonly syncing: boolean;
  readonly removing: boolean;
  readonly onSync: () => void;
  readonly onRemove: () => void;
}) {
  const { source, notice } = props;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{source.name}</h3>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{source.slug}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" onClick={props.onSync} loading={props.syncing}>
            Sync
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={props.removing}
              >
                Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {source.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes {source.tools.length} {source.tools.length === 1 ? "tool" : "tools"}{" "}
                  from the catalog. The GitHub repository is untouched; re-add it to sync again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={props.onRemove}>
                  {props.removing ? "Removing..." : "Remove source"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="space-y-6 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <LinkField label="GitHub URL" value={source.url} />
          <Field label="Ref" value={source.ref} />
          <Field label="Upstream SHA" value={source.upstreamSha} mono />
          <Field label="Last synced" value={formatDate(source.publishedAt)} />
          <Field label="Access token" value={source.hasToken ? "Stored" : "Not set"} />
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

        {props.removeError && <FormErrorMessage message={props.removeError} />}

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

function LinkField(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{props.label}</dt>
      <dd className="mt-1 truncate text-sm text-foreground">
        <a className="underline underline-offset-2" href={props.value}>
          {props.value}
        </a>
      </dd>
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

function FormErrorMessage(props: { readonly message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-[12px] text-destructive">{props.message}</p>
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
