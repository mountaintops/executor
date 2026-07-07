import { useEffect, useState } from "react";
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
import { Button } from "@executor-js/react/components/button";

import type { GitHubCustomToolsSourceSummary } from "../api";
import {
  consoleIntegrationHref,
  getCustomToolSourceEffect,
  removeCustomToolSourceEffect,
  syncCustomToolSourceEffect,
} from "./custom-tools-client";
import { sourcePanelModel, syncNoticeFromResult, type SyncNoticeModel } from "./source-panel-model";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly source: GitHubCustomToolsSourceSummary };

export default function CustomToolsAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
}) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<SyncNoticeModel | null>(null);
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
        skipped: [],
      });
      setSyncing(false);
      return;
    }
    const result = exit.value;
    setNotice(syncNoticeFromResult(result, beforeTools));
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
  readonly notice: SyncNoticeModel | null;
  readonly removeError: string | null;
  readonly syncing: boolean;
  readonly removing: boolean;
  readonly onSync: () => void;
  readonly onRemove: () => void;
}) {
  const { source, notice } = props;
  const model = sourcePanelModel(source);
  const noticeHasDetails =
    notice !== null &&
    (notice.added.length > 0 ||
      notice.removed.length > 0 ||
      notice.errors.length > 0 ||
      notice.skipped.length > 0 ||
      notice.upstreamSha !== undefined);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{model.title}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            <a
              className="underline underline-offset-2"
              href={model.repository.href}
              target="_blank"
              rel="noreferrer"
            >
              {model.repository.label}
            </a>
          </p>
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

      <div className="space-y-5 p-4">
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted-foreground">{model.lastSynced}</p>
          <p>
            <a
              className="font-medium underline underline-offset-2"
              href={model.publishedTools.href}
            >
              {model.publishedTools.label}
            </a>{" "}
            <span className="text-muted-foreground">published</span>
          </p>
        </div>

        {notice && (
          <Alert variant={notice.status === "failed" ? "destructive" : "default"}>
            <AlertTitle>{notice.message}</AlertTitle>
            {noticeHasDetails && (
              <AlertDescription>
                <div className="space-y-1">
                  {notice.added.length > 0 && <p>Added: {notice.added.join(", ")}</p>}
                  {notice.removed.length > 0 && <p>Removed: {notice.removed.join(", ")}</p>}
                  {notice.errors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                  {notice.skipped.length > 0 && (
                    <div className="space-y-1">
                      <p>Skipped:</p>
                      <ul className="space-y-1">
                        {notice.skipped.map((entry) => (
                          <li key={`${entry.path}:${entry.reason}`} className="flex gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {entry.path}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {entry.reason}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {notice.upstreamSha && (
                    <p className="font-mono text-xs text-muted-foreground">
                      Commit {notice.upstreamSha}
                    </p>
                  )}
                </div>
              </AlertDescription>
            )}
          </Alert>
        )}

        {props.removeError && <FormErrorMessage message={props.removeError} />}
      </div>
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
