import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Effect, Exit } from "effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import { toast } from "@executor-js/react/components/sonner";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";

import {
  consoleIntegrationHref,
  formatSyncErrors,
  githubConnections,
  syncCustomToolSourceEffect,
  syncStatusLabel,
  validateGitHubRepo,
} from "./custom-tools-client";

export default function AddCustomToolsSource(props: {
  readonly onComplete: (slug?: string) => void;
  readonly onCancel: () => void;
}) {
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const connections = useMemo(
    () =>
      AsyncResult.isSuccess(connectionsResult) ? githubConnections(connectionsResult.value) : [],
    [connectionsResult],
  );
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [connection, setConnection] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const selectedConnection = connection || connections[0]?.address || "";
  const loadingConnections = !AsyncResult.isSuccess(connectionsResult);
  const canSubmit =
    repo.trim().length > 0 && selectedConnection.length > 0 && !syncing && !loadingConnections;

  const submit = async () => {
    const validation = validateGitHubRepo(repo);
    setRepoError(validation);
    setSyncError(null);
    if (validation || !selectedConnection) return;

    setSyncing(true);
    const exit = await Effect.runPromiseExit(
      syncCustomToolSourceEffect({
        repo,
        ref,
        connection: selectedConnection,
      }),
    );
    if (Exit.isFailure(exit)) {
      setSyncError("Failed to sync custom tools.");
      setSyncing(false);
      return;
    }
    const result = exit.value;
    if (result.status === "failed") {
      setSyncError(formatSyncErrors(result).join("\n") || "Sync failed.");
      setSyncing(false);
      return;
    }
    toast.success(syncStatusLabel(result));
    props.onComplete("apps");
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add custom tools</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Sync a GitHub repository that defines tools with executor:app.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="GitHub repo" description="- Owner and repository name.">
            <div className="space-y-1.5">
              <Input
                value={repo}
                onChange={(event) => {
                  setRepo((event.target as HTMLInputElement).value);
                  setRepoError(null);
                  setSyncError(null);
                }}
                onBlur={() => setRepoError(validateGitHubRepo(repo))}
                placeholder="owner/name"
                className="font-mono text-sm"
                aria-invalid={repoError ? true : undefined}
              />
              {repoError && <p className="text-xs text-destructive">{repoError}</p>}
            </div>
          </CardStackEntryField>

          <CardStackEntryField label="Ref" description="- Branch, tag, or commit SHA.">
            <Input
              value={ref}
              onChange={(event) => setRef((event.target as HTMLInputElement).value)}
              placeholder="default branch"
              className="font-mono text-sm"
            />
          </CardStackEntryField>

          <CardStackEntryField
            label="GitHub connection"
            description="- Used to fetch the repo and later resync it."
          >
            {connections.length > 0 ? (
              <NativeSelect
                value={selectedConnection}
                onChange={(event) => setConnection((event.target as HTMLSelectElement).value)}
                className="w-full font-mono text-sm"
                disabled={syncing}
              >
                {connections.map((candidate) => (
                  <NativeSelectOption key={candidate.address} value={candidate.address}>
                    {candidate.address}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <Alert>
                <AlertTitle>No GitHub connections</AlertTitle>
                <AlertDescription>
                  <span>
                    Connect GitHub first, then return here to sync a custom-tools repo.{" "}
                    <a
                      className="font-medium text-foreground underline"
                      href={consoleIntegrationHref("/integrations/github")}
                    >
                      Open GitHub
                    </a>
                  </span>
                </AlertDescription>
              </Alert>
            )}
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      {syncError && <FormErrorAlert message={syncError} />}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={syncing}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={!canSubmit} loading={syncing}>
          Sync repo
        </Button>
      </FloatActions>
    </div>
  );
}
