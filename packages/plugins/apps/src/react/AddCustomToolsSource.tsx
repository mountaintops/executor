import { useState } from "react";
import { Effect, Exit } from "effect";

import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { toast } from "@executor-js/react/components/sonner";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";

import {
  formatSyncErrors,
  syncCustomToolSourceEffect,
  syncStatusLabel,
  validateGitHubSourceUrl,
} from "./custom-tools-client";

export default function AddCustomToolsSource(props: {
  readonly onComplete: (slug?: string) => void;
  readonly onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const submit = async () => {
    const validation = validateGitHubSourceUrl(url);
    setUrlError(validation);
    setSyncError(null);
    if (validation) return;

    setSyncing(true);
    const exit = await Effect.runPromiseExit(
      syncCustomToolSourceEffect({
        url,
        token,
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
          <CardStackEntryField
            label="GitHub URL"
            description="- Repository URL, optionally with /tree/<ref> or /commit/<sha>."
          >
            <div className="space-y-1.5">
              <Input
                value={url}
                onChange={(event) => {
                  setUrl((event.target as HTMLInputElement).value);
                  setUrlError(null);
                  setSyncError(null);
                }}
                onBlur={() => setUrlError(validateGitHubSourceUrl(url))}
                placeholder="https://github.com/UsefulSoftwareCo/executor"
                className="font-mono text-sm"
                aria-invalid={urlError ? true : undefined}
              />
              {urlError && <p className="text-xs text-destructive">{urlError}</p>}
            </div>
          </CardStackEntryField>

          <CardStackEntryField
            label="Access token (optional)"
            description="- Needed only for private repositories or higher GitHub API limits."
          >
            <div className="flex gap-2">
              <Input
                value={token}
                type={tokenRevealed ? "text" : "password"}
                onChange={(event) => {
                  setToken((event.target as HTMLInputElement).value);
                  setSyncError(null);
                }}
                autoComplete="off"
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                aria-pressed={tokenRevealed}
                onClick={() => setTokenRevealed((revealed) => !revealed)}
                disabled={syncing}
              >
                Show
              </Button>
            </div>
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      {syncError && <FormErrorAlert message={syncError} />}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={syncing}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={syncing} loading={syncing}>
          Sync repo
        </Button>
      </FloatActions>
    </div>
  );
}
