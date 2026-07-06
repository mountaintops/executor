import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { CheckIcon, CircleIcon, TriangleAlert } from "lucide-react";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import { Button } from "@executor-js/react/components/button";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import {
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";
import { OpenApiSourceDetailsFields } from "@executor-js/plugin-openapi/react";

import { addMicrosoftWorkloads } from "./atoms";
import { MicrosoftScopePicker } from "./MicrosoftScopePicker";
import {
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftGraphPresetForId,
  microsoftServiceSlug,
} from "../sdk/presets";
import type { MicrosoftAddWorkloadsInput, MicrosoftAddWorkloadsResult } from "../sdk/plugin";
import { MICROSOFT_CUSTOM_WORKLOAD_ID } from "../sdk/plugin";

const MICROSOFT_FAVICON = "https://www.microsoft.com/favicon.ico";

const defaultPresetIds: ReadonlySet<string> = new Set(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS);

export type MicrosoftWorkloadIdentityOverride = {
  readonly slug: string;
  readonly name: string;
};

export type MicrosoftCustomWorkloadInput = {
  readonly customScopes: readonly string[];
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
};

export type AddMicrosoftWorkloadsMutation = (input: {
  readonly payload: MicrosoftAddWorkloadsInput;
  readonly reactivityKeys: typeof integrationWriteKeys;
}) => Promise<Exit.Exit<MicrosoftAddWorkloadsResult, unknown>>;

export const microsoftAddWorkloadsPayload = (input: {
  readonly presetIds: readonly string[];
  readonly identityOverride?: MicrosoftWorkloadIdentityOverride;
  readonly custom?: MicrosoftCustomWorkloadInput;
  readonly baseUrl?: string;
}): MicrosoftAddWorkloadsInput => {
  const identityOverride =
    input.presetIds.length === 1 && !input.custom ? input.identityOverride : undefined;
  const presetWorkloads = input.presetIds.map((presetId: string) => ({
    presetId,
    ...(identityOverride?.slug.trim() ? { slug: identityOverride.slug.trim() } : {}),
    ...(identityOverride?.name.trim() ? { name: identityOverride.name.trim() } : {}),
  }));
  const custom =
    input.custom && input.custom.customScopes.length > 0
      ? [
          {
            custom: {
              customScopes: [...input.custom.customScopes],
              slug: input.custom.slug,
              name: input.custom.name,
              ...(input.custom.description?.trim()
                ? { description: input.custom.description.trim() }
                : {}),
            },
          },
        ]
      : [];
  const workloads = [...presetWorkloads, ...custom];
  const baseUrl = input.baseUrl?.trim() ?? "";
  return baseUrl.length > 0 ? { workloads, baseUrl } : { workloads };
};

export const submitMicrosoftWorkloadsSelection = (
  doAddWorkloads: AddMicrosoftWorkloadsMutation,
  input: {
    readonly presetIds: readonly string[];
    readonly identityOverride?: MicrosoftWorkloadIdentityOverride;
    readonly custom?: MicrosoftCustomWorkloadInput;
    readonly baseUrl?: string;
  },
): Promise<Exit.Exit<MicrosoftAddWorkloadsResult, unknown>> =>
  doAddWorkloads({
    payload: microsoftAddWorkloadsPayload(input),
    reactivityKeys: integrationWriteKeys,
  });

export type MicrosoftWorkloadResultRow =
  | {
      readonly status: "added";
      readonly presetId: string;
      readonly slug: string;
      readonly toolCount: number;
    }
  | {
      readonly status: "skipped";
      readonly presetId: string;
      readonly slug: string;
      readonly reason: "already_exists";
    }
  | {
      readonly status: "failed";
      readonly presetId: string;
      readonly slug: string;
      readonly error: string;
    };

export const microsoftAddWorkloadsResultRows = (
  result: MicrosoftAddWorkloadsResult,
): readonly MicrosoftWorkloadResultRow[] => [
  ...result.added.map((entry) => ({
    status: "added" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    toolCount: entry.toolCount,
  })),
  ...result.skipped.map((entry) => ({
    status: "skipped" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    reason: entry.reason,
  })),
  ...result.failed.map((entry) => ({
    status: "failed" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    error: entry.error,
  })),
];

export const mergeMicrosoftAddWorkloadsResult = (
  previous: MicrosoftAddWorkloadsResult,
  next: MicrosoftAddWorkloadsResult,
): MicrosoftAddWorkloadsResult => {
  const nextPresetIds = new Set(microsoftAddWorkloadsResultRows(next).map((row) => row.presetId));
  return {
    added: [...previous.added.filter((entry) => !nextPresetIds.has(entry.presetId)), ...next.added],
    skipped: [
      ...previous.skipped.filter((entry) => !nextPresetIds.has(entry.presetId)),
      ...next.skipped,
    ],
    failed: [
      ...previous.failed.filter((entry) => !nextPresetIds.has(entry.presetId)),
      ...next.failed,
    ],
  };
};

const microsoftPresetName = (presetId: string): string =>
  presetId === MICROSOFT_CUSTOM_WORKLOAD_ID
    ? "Custom Graph scopes"
    : (microsoftGraphPresetForId(presetId)?.name ?? presetId);

export function MicrosoftWorkloadResultPanel(props: {
  readonly result: MicrosoftAddWorkloadsResult;
  readonly retryingPresetId: string | null;
  readonly onRetry: (presetId: string) => void | Promise<void>;
}) {
  const rows = microsoftAddWorkloadsResultRows(props.result);
  if (rows.length === 0) return null;

  return (
    <section
      data-testid="microsoft-add-results"
      className="space-y-3 rounded-lg border border-border bg-muted/10 px-3 py-3"
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">Microsoft workloads</h2>
        <p className="text-[11px] text-muted-foreground">
          Each selected workload is added as its own integration.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row: MicrosoftWorkloadResultRow) => {
          const presetName = microsoftPresetName(row.presetId);
          return (
            <li
              key={`${row.status}:${row.presetId}`}
              data-testid={`add-result-row-${row.presetId}`}
              data-state={row.status}
              className="flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2"
            >
              <span
                className={
                  row.status === "added"
                    ? "mt-0.5 text-emerald-600"
                    : row.status === "skipped"
                      ? "mt-0.5 text-muted-foreground"
                      : "mt-0.5 text-destructive"
                }
              >
                {row.status === "added" ? (
                  <CheckIcon className="size-3.5" />
                ) : row.status === "skipped" ? (
                  <CircleIcon className="size-3.5" />
                ) : (
                  <TriangleAlert className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{presetName}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {row.status === "added"
                      ? "Added"
                      : row.status === "skipped"
                        ? "Already exists"
                        : "Failed"}
                  </span>
                </div>
                {row.status === "added" ? (
                  <p className="text-[11px] text-muted-foreground">
                    {row.toolCount} tool{row.toolCount === 1 ? "" : "s"} added.
                  </p>
                ) : row.status === "skipped" ? (
                  <p className="text-[11px] text-muted-foreground">
                    This integration already exists.
                  </p>
                ) : (
                  <p className="text-[11px] text-destructive">{row.error}</p>
                )}
              </div>
              {row.status === "failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-testid={`add-result-retry-${row.presetId}`}
                  loading={props.retryingPresetId === row.presetId}
                  onClick={() => void props.onRetry(row.presetId)}
                >
                  Retry
                </Button>
              ) : (
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/{-$orgSlug}/integrations/$namespace" params={{ namespace: row.slug }}>
                    Open
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const BaseUrlSettings = (props: {
  readonly baseUrl: string;
  readonly onBaseUrlChange: (value: string) => void;
}) => (
  <section className="space-y-2 rounded-lg border border-border bg-muted/10 px-3 py-3">
    <div className="space-y-1">
      <FieldLabel>Microsoft workload settings</FieldLabel>
      <p className="text-[11px] text-muted-foreground">
        Selected workloads keep their preset names and namespaces.
      </p>
    </div>
    <Input
      value={props.baseUrl}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onBaseUrlChange(event.target.value)}
      placeholder={MICROSOFT_GRAPH_BASE_URL}
      className="font-mono text-sm"
    />
  </section>
);

export default function AddMicrosoftSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialNamespace?: string;
}) {
  const [selectedPresetIds, setSelectedPresetIds] = useState<ReadonlySet<string>>(defaultPresetIds);
  const [customScopes, setCustomScopes] = useState<readonly string[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [retryingPresetId, setRetryingPresetId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [workloadsResult, setWorkloadsResult] = useState<MicrosoftAddWorkloadsResult | null>(null);

  const selectedIds = useMemo(() => [...selectedPresetIds], [selectedPresetIds]);
  const singleSelectedPreset =
    selectedIds.length === 1 ? microsoftGraphPresetForId(selectedIds[0]!) : undefined;
  const hasCustomScopes = customScopes.length > 0;

  const identity = useIntegrationIdentity({
    fallbackName: hasCustomScopes
      ? "Custom Microsoft Graph"
      : (singleSelectedPreset?.name ?? "Microsoft Graph"),
    fallbackNamespace:
      props.initialNamespace ??
      (hasCustomScopes
        ? "microsoft_graph_custom"
        : singleSelectedPreset
          ? microsoftServiceSlug(singleSelectedPreset.id)
          : "microsoft_graph"),
  });

  const togglePreset = useCallback((presetId: string, checked: boolean) => {
    setSelectedPresetIds((current: ReadonlySet<string>) => {
      const next = new Set(current);
      if (checked) next.add(presetId);
      else next.delete(presetId);
      return next;
    });
  }, []);

  const addCustomScope = useCallback((scope: string) => {
    setCustomScopes((current: readonly string[]) =>
      current.includes(scope) ? current : [...current, scope],
    );
  }, []);

  const removeCustomScope = useCallback((scope: string) => {
    setCustomScopes((current: readonly string[]) =>
      current.filter((entry: string) => entry !== scope),
    );
  }, []);

  const doAddWorkloads = useAtomSet(addMicrosoftWorkloads, { mode: "promiseExit" });

  const resolvedSourceId = slugifyNamespace(identity.namespace) || "microsoft_graph_custom";
  const resolvedDisplayName =
    identity.name.trim() ||
    (hasCustomScopes
      ? "Custom Microsoft Graph"
      : (singleSelectedPreset?.name ?? "Microsoft Graph"));
  const resolvedDescription =
    descriptionDraft ??
    (hasCustomScopes ? "Custom Microsoft Graph scopes." : "Selected Microsoft Graph workloads.");
  const customGraphSlugAlreadyExists = useSlugAlreadyExists(
    hasCustomScopes ? resolvedSourceId : "",
  );
  const identityOverride =
    selectedIds.length === 1 && !hasCustomScopes
      ? { slug: resolvedSourceId, name: resolvedDisplayName }
      : undefined;
  const customWorkload =
    customScopes.length > 0
      ? {
          customScopes: [...customScopes],
          slug: resolvedSourceId,
          name: resolvedDisplayName,
          description: resolvedDescription,
        }
      : undefined;
  const canAdd =
    (selectedIds.length > 0 || customScopes.length > 0) && !customGraphSlugAlreadyExists && !adding;

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    setWorkloadsResult(null);
    const exit = await submitMicrosoftWorkloadsSelection(doAddWorkloads, {
      presetIds: selectedIds,
      ...(identityOverride ? { identityOverride } : {}),
      ...(customWorkload ? { custom: customWorkload } : {}),
      baseUrl,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add Microsoft workloads"));
      setAdding(false);
      return;
    }
    setWorkloadsResult(exit.value);
    setAdding(false);
  };

  const handleRetry = async (presetId: string) => {
    setRetryingPresetId(presetId);
    setAddError(null);
    const retryingCustom = presetId === MICROSOFT_CUSTOM_WORKLOAD_ID;
    const retryIdentityOverride =
      !retryingCustom && identityOverride && selectedIds.length === 1 && selectedIds[0] === presetId
        ? identityOverride
        : undefined;
    const exit = await submitMicrosoftWorkloadsSelection(doAddWorkloads, {
      presetIds: retryingCustom ? [] : [presetId],
      ...(retryIdentityOverride ? { identityOverride: retryIdentityOverride } : {}),
      ...(retryingCustom && customWorkload ? { custom: customWorkload } : {}),
      baseUrl,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add Microsoft workload"));
      setRetryingPresetId(null);
      return;
    }
    setWorkloadsResult((current) =>
      current ? mergeMicrosoftAddWorkloadsResult(current, exit.value) : exit.value,
    );
    setRetryingPresetId(null);
  };

  const showIdentityDetails = selectedIds.length === 1 || hasCustomScopes;
  const detailTitle = hasCustomScopes
    ? "Custom Microsoft Graph scopes"
    : (singleSelectedPreset?.name ?? "Microsoft Graph");
  const detailSubtitle = hasCustomScopes
    ? `${customScopes.length} custom scope${
        customScopes.length === 1 ? "" : "s"
      } added as its own integration.`
    : "This workload is added as its own integration.";

  const dismiss = () => {
    if (workloadsResult) {
      props.onComplete();
      return;
    }
    props.onCancel();
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Microsoft integration</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Each selected workload is added as its own integration.
        </p>
      </div>

      <MicrosoftScopePicker
        selectedPresetIds={selectedPresetIds}
        onToggle={togglePreset}
        customScopes={customScopes}
        onAddCustomScope={addCustomScope}
        onRemoveCustomScope={removeCustomScope}
      />

      {showIdentityDetails ? (
        <OpenApiSourceDetailsFields
          title={detailTitle}
          subtitle={detailSubtitle}
          identity={identity}
          {...(hasCustomScopes
            ? { description: resolvedDescription, onDescriptionChange: setDescriptionDraft }
            : {})}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          baseUrlLabel="Base URL override (optional)"
          baseUrlPlaceholder={MICROSOFT_GRAPH_BASE_URL}
          faviconIcon={MICROSOFT_FAVICON}
          faviconUrl={baseUrl || MICROSOFT_GRAPH_BASE_URL}
        />
      ) : (
        <BaseUrlSettings baseUrl={baseUrl} onBaseUrlChange={setBaseUrl} />
      )}

      {customGraphSlugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSourceId} />}

      {addError && <FormErrorAlert message={addError} />}

      {workloadsResult && (
        <MicrosoftWorkloadResultPanel
          result={workloadsResult}
          retryingPresetId={retryingPresetId}
          onRetry={handleRetry}
        />
      )}

      <FloatActions>
        <Button variant="ghost" onClick={dismiss} disabled={adding || retryingPresetId !== null}>
          {workloadsResult ? "Done" : "Cancel"}
        </Button>
        <Button
          data-testid="microsoft-add-submit"
          onClick={() => void handleAdd()}
          disabled={!canAdd}
          loading={adding}
        >
          Connect Microsoft
        </Button>
      </FloatActions>
    </div>
  );
}
