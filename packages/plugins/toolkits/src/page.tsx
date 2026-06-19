import { useId, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  ArrowLeftIcon,
  BoxIcon,
  CheckIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  Trash2Icon,
} from "lucide-react";
import {
  createPluginAtomClient,
  useIntegrationPlugins,
  type IntegrationPlugin,
  type PluginPageProps,
} from "@executor-js/sdk/client";
import {
  isValidPattern,
  matchPattern,
  type EffectivePolicy,
  type Integration,
  type Owner,
  type ToolAddress,
  type ToolPolicyAction,
} from "@executor-js/sdk/shared";
import { integrationsOptimisticAtom, toolsAllAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { ownerLabel } from "@executor-js/react/api/owner-display";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  IntegrationFavicon,
  integrationPresetIconUrl,
} from "@executor-js/react/components/integration-favicon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { ToolDetail, ToolDetailEmpty } from "@executor-js/react/components/tool-detail";
import { ToolTree, type ToolSummary } from "@executor-js/react/components/tool-tree";
import {
  POLICY_ACTION_LABEL,
  POLICY_ACTIONS_IN_ORDER,
  POLICY_BADGE_VARIANT,
} from "@executor-js/react/lib/policy-display";
import { cn } from "@executor-js/react/lib/utils";

import { ToolkitsApi, type ToolkitPolicyResponse, type ToolkitResponse } from "./shared";

const ToolkitsClient = createPluginAtomClient(ToolkitsApi, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});

const toolkitWriteKeys = [ReactivityKey.policies, ReactivityKey.tools] as const;

const toolkitsAtom = ToolkitsClient.query("toolkits", "list", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.policies],
});

const toolkitPoliciesAtom = (toolkitId: string) =>
  ToolkitsClient.query("toolkits", "listPolicies", {
    params: { toolkitId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.policies],
  });

const createToolkit = ToolkitsClient.mutation("toolkits", "create");
const removeToolkit = ToolkitsClient.mutation("toolkits", "remove");
const createToolkitPolicy = ToolkitsClient.mutation("toolkits", "createPolicy");
const updateToolkitPolicy = ToolkitsClient.mutation("toolkits", "updatePolicy");
const removeToolkitPolicy = ToolkitsClient.mutation("toolkits", "removePolicy");

type ToolRow = {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly owner?: Owner;
  readonly connection?: string;
  readonly name: string;
  readonly description?: string;
  readonly requiresApproval?: boolean;
  readonly static?: boolean;
};

const comparePolicy = (a: ToolkitPolicyResponse, b: ToolkitPolicyResponse): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const blockedPolicy: EffectivePolicy = {
  action: "block",
  source: "user",
  pattern: "*",
};

const resolveToolkitPolicy = (
  matchId: string,
  policies: readonly ToolkitPolicyResponse[],
): EffectivePolicy => {
  for (const policy of [...policies].sort(comparePolicy)) {
    if (!matchPattern(policy.pattern, matchId)) continue;
    return {
      action: policy.action,
      source: "user",
      pattern: policy.pattern,
      policyId: policy.id,
    };
  }
  return blockedPolicy;
};

const toolMatchId = (tool: ToolRow): string =>
  tool.static ? String(tool.address) : String(tool.address).replace(/^tools\./, "");

const toolCanAppearInToolkit = (toolkit: ToolkitResponse, tool: ToolRow): boolean =>
  toolkit.owner === "user" || tool.static === true || tool.owner !== "user";

const toolkitUrlFor = (orgSlug: string | undefined, slug: string): string => {
  const path = orgSlug ? `/${orgSlug}/mcp/toolkits/${slug}` : `/mcp/toolkits/${slug}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
};

const identityPattern = (displayPattern: string): string => displayPattern;

const formatUpdatedAt = (value: number): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

const toolkitScopeLabel = (toolkit: ToolkitResponse): string =>
  toolkit.owner === "org" ? "Workspace tools" : "Workspace + personal tools";

const compareToolkitRows = (a: ToolkitResponse, b: ToolkitResponse): number => {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.name.localeCompare(b.name);
};

const toolkitCardStyle = { minHeight: "9rem" };
const toolkitShelfStyle = { minHeight: "28.5rem" };
const toolkitGridContainerStyle = { maxWidth: "80rem" };
const toolkitConnectionSidebarStyle = { width: "20rem" };
const toolkitToolTreeStyle = { width: "22rem" };

const ownerAccentClass = (owner: Owner): string =>
  owner === "org"
    ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";

type ToolkitConnectionGroup = {
  readonly id: string;
  readonly owner: Owner;
  readonly integration: string;
  readonly connection: string;
  readonly patterns: readonly string[];
  readonly tools: readonly ToolRow[];
};

type IntegrationMeta = {
  readonly name: string;
  readonly sourceId: string;
  readonly icon?: string | null;
  readonly url?: string;
};

const toolOwner = (tool: ToolRow): Owner => (tool.static ? "org" : (tool.owner ?? "org"));

const toolConnectionName = (tool: ToolRow): string => {
  if (tool.connection && tool.connection.length > 0) return tool.connection;
  return tool.static ? "built-in" : "default";
};

const policyPrefixForTool = (tool: ToolRow): string => {
  const matchId = toolMatchId(tool);
  const integration = String(tool.integration);
  if (tool.connection && tool.connection.length > 0) {
    const connection = String(tool.connection);
    if (tool.owner) {
      const ownerConnectionPrefix = `${integration}.${tool.owner}.${connection}`;
      if (matchId === ownerConnectionPrefix || matchId.startsWith(`${ownerConnectionPrefix}.`)) {
        return ownerConnectionPrefix;
      }
    }
    const connectionPrefix = `${integration}.${connection}`;
    if (matchId === connectionPrefix || matchId.startsWith(`${connectionPrefix}.`)) {
      return connectionPrefix;
    }
  }
  const name = String(tool.name);
  if (name.length > 0 && matchId.endsWith(`.${name}`)) {
    return matchId.slice(0, -name.length - 1);
  }
  const segments = matchId.split(".");
  return segments.length > 1 ? segments.slice(0, -1).join(".") : matchId;
};

const connectionPatternForTool = (tool: ToolRow): string => `${policyPrefixForTool(tool)}.*`;

const compareConnectionGroups = (a: ToolkitConnectionGroup, b: ToolkitConnectionGroup): number => {
  const ownerRank = (owner: Owner) => (owner === "org" ? 0 : 1);
  return (
    ownerRank(a.owner) - ownerRank(b.owner) ||
    a.integration.localeCompare(b.integration) ||
    a.connection.localeCompare(b.connection) ||
    a.id.localeCompare(b.id)
  );
};

const patternSubsumes = (candidate: string, covered: string): boolean => {
  if (candidate === covered) return true;
  if (!candidate.endsWith(".*")) return false;
  const prefix = candidate.slice(0, -1);
  return covered.startsWith(prefix);
};

const reducePolicyPatterns = (patterns: readonly string[]): readonly string[] => {
  const unique = [...new Set(patterns)].sort((a, b) => a.localeCompare(b));
  return unique.filter(
    (pattern) =>
      !unique.some((candidate) => candidate !== pattern && patternSubsumes(candidate, pattern)),
  );
};

const buildConnectionGroups = (tools: readonly ToolRow[]): readonly ToolkitConnectionGroup[] => {
  const groups = new Map<string, ToolkitConnectionGroup & { tools: ToolRow[] }>();
  for (const tool of tools) {
    const owner = toolOwner(tool);
    const key = `${owner}:${tool.integration}:${toolConnectionName(tool)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tools.push(tool);
      continue;
    }
    groups.set(key, {
      id: key,
      owner,
      integration: String(tool.integration),
      connection: toolConnectionName(tool),
      patterns: [],
      tools: [tool],
    });
  }
  return [...groups.values()]
    .map((group) => {
      const sortedTools = [...group.tools].sort(compareTools);
      return {
        ...group,
        patterns: reducePolicyPatterns(sortedTools.map(connectionPatternForTool)),
        tools: sortedTools,
      };
    })
    .sort(compareConnectionGroups);
};

const compareTools = (a: ToolRow, b: ToolRow): number =>
  String(a.name).localeCompare(String(b.name)) || toolMatchId(a).localeCompare(toolMatchId(b));

const connectionTitle = (group: ToolkitConnectionGroup): string =>
  `${group.integration} / ${group.connection}`;

const connectionDisplayTitle = (group: ToolkitConnectionGroup, meta: IntegrationMeta): string =>
  group.connection === "built-in" || group.connection === "default" ? meta.name : group.connection;

const connectionDisplaySubtitle = (group: ToolkitConnectionGroup, meta: IntegrationMeta): string =>
  group.connection === "built-in" || group.connection === "default"
    ? `${group.tools.length} ${group.tools.length === 1 ? "tool" : "tools"}`
    : `${meta.name} · ${group.tools.length} ${group.tools.length === 1 ? "tool" : "tools"}`;

const integrationMetaFor = (
  group: ToolkitConnectionGroup,
  integrations: readonly Integration[],
  integrationPlugins: readonly IntegrationPlugin[],
): IntegrationMeta => {
  const integration = integrations.find((row) => String(row.slug) === group.integration);
  const fallbackName = group.integration
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  const source = {
    id: group.integration,
    kind: integration?.kind ?? group.integration,
    name: integration?.name ?? fallbackName,
    url: integration?.displayUrl,
  };
  return {
    name: source.name,
    sourceId: group.integration,
    icon: integrationPresetIconUrl(source, integrationPlugins),
    ...(source.url ? { url: source.url } : {}),
  };
};

const policyForExactPattern = (
  policies: readonly ToolkitPolicyResponse[],
  pattern: string,
): ToolkitPolicyResponse | undefined => policies.find((policy) => policy.pattern === pattern);

function ToolkitTile(props: { pluginId: string; toolkit: ToolkitResponse }) {
  const toolkit = props.toolkit;
  const scope = toolkitScopeLabel(toolkit);
  return (
    <Link
      to="/{-$orgSlug}/plugins/$pluginId/$"
      params={{ pluginId: props.pluginId, _splat: toolkit.slug }}
      aria-label={`Open toolkit ${toolkit.name}`}
      className="group flex min-h-36 min-w-0 self-start flex-col justify-between rounded-md border border-border/70 bg-card p-3.5 text-left text-card-foreground shadow-xs transition-[border-color,background-color,box-shadow] hover:border-foreground/25 hover:bg-muted/20 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border",
            ownerAccentClass(toolkit.owner),
          )}
        >
          <BoxIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{toolkit.name}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {toolkit.slug}
          </div>
        </div>
      </div>

      <div className="mt-5 min-w-0 space-y-3">
        <code className="block truncate rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors group-hover:border-border">
          /mcp/toolkits/{toolkit.slug}
        </code>
        <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate">{scope}</span>
          <span className="shrink-0 tabular-nums">{formatUpdatedAt(toolkit.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

const addToolkitScopeLabel = (owner: Owner): string => (owner === "org" ? "workspace" : "personal");
const addToolkitTitle = (owner: Owner): string =>
  owner === "org" ? "New workspace toolkit" : "New personal toolkit";

function CreateToolkitDialog(props: {
  owner: Owner;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const inputId = useId();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const title = addToolkitTitle(props.owner);

  const submit = async () => {
    if (!trimmed) return;
    await props.onCreate({ owner: props.owner, name: trimmed });
    setName("");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) setName("");
      }}
    >
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden rounded-md border-border/80 bg-card p-0 shadow-2xl"
        style={{ width: "min(24rem, calc(100vw - 2rem))" }}
      >
        <form
          className="grid"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader className="px-4 pb-1 pt-4">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">
              Group tools and expose them at a dedicated MCP URL.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 px-4 py-3">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              Toolkit name
            </Label>
            <Input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Support tools"
              autoFocus
              className="h-9"
            />
          </div>
          <DialogFooter className="px-4 pb-4 pt-1">
            <Button
              type="submit"
              size="sm"
              disabled={!trimmed}
              aria-label="Create toolkit"
              className="h-8"
            >
              Create toolkit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddToolkitCard(props: { owner: Owner; onClick: () => void }) {
  const scopeLabel = addToolkitScopeLabel(props.owner);
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={`Add ${scopeLabel} toolkit`}
      className="group flex min-h-36 min-w-0 self-start items-center justify-center rounded-md border border-dashed border-border/75 bg-card/40 text-muted-foreground transition-[border-color,background-color,box-shadow,color] hover:border-foreground/25 hover:bg-muted/20 hover:text-foreground hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-md border transition-[border-color,background-color,color,transform]",
          ownerAccentClass(props.owner),
          "group-hover:scale-105",
        )}
      >
        <PlusIcon className="size-6" />
      </span>
    </button>
  );
}

function ToolkitSection(props: {
  pluginId: string;
  owner: Owner;
  title: string;
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const rows = [...props.toolkits].sort(compareToolkitRows);
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);
  return (
    <section className="space-y-3">
      <div className="border-b border-border/60 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {props.title}
        </h2>
      </div>

      <div
        className="grid content-start grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"
        style={toolkitShelfStyle}
      >
        {rows.map((toolkit) => (
          <ToolkitTile key={toolkit.id} pluginId={props.pluginId} toolkit={toolkit} />
        ))}
        <AddToolkitCard owner={props.owner} onClick={openCreate} />
      </div>

      <CreateToolkitDialog
        owner={props.owner}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={props.onCreate}
      />
    </section>
  );
}

function ToolkitGrid(props: {
  pluginId: string;
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  // Toolkit shelves are grouped by owner; the selected toolkit owns the page.
  const workspaceToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "org");
  const personalToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "user");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
        <ToolkitSection
          pluginId={props.pluginId}
          owner="org"
          title="Workspace"
          toolkits={workspaceToolkits}
          onCreate={props.onCreate}
        />
        <ToolkitSection
          pluginId={props.pluginId}
          owner="user"
          title="Personal"
          toolkits={personalToolkits}
          onCreate={props.onCreate}
        />
      </div>
    </div>
  );
}

function ToolkitRuleForm(props: {
  onCreate: (pattern: string, action: ToolPolicyAction) => Promise<void> | void;
}) {
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<ToolPolicyAction>("approve");
  const trimmed = pattern.trim();
  const valid = isValidPattern(trimmed);
  return (
    <form
      className="border-t border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void props.onCreate(trimmed, action);
        setPattern("");
      }}
    >
      <Label htmlFor="toolkit-policy-pattern" className="text-xs text-muted-foreground">
        Add rule
      </Label>
      <div className="mt-2 flex gap-2">
        <Input
          id="toolkit-policy-pattern"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="github.org.main.*"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Select value={action} onValueChange={(value) => setAction(value as ToolPolicyAction)}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLICY_ACTIONS_IN_ORDER.map((option) => (
              <SelectItem key={option} value={option}>
                {POLICY_ACTION_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="icon-sm" disabled={!valid} aria-label="Add toolkit rule">
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}

function ToolkitRules(props: {
  policies: readonly ToolkitPolicyResponse[];
  onUpdate: (policy: ToolkitPolicyResponse, action: ToolPolicyAction) => Promise<void> | void;
  onRemove: (policy: ToolkitPolicyResponse) => Promise<void> | void;
}) {
  const sorted = [...props.policies].sort(comparePolicy);
  return (
    <div className="max-h-56 min-h-0 overflow-y-auto border-t border-border/60">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <ShieldIcon className="size-3" />
          Rules
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-3 pb-3 text-xs leading-relaxed text-muted-foreground">
          No rules. Add a connection to expose tools through this toolkit.
        </div>
      ) : (
        <div className="pb-2">
          {sorted.map((policy) => (
            <div key={policy.id} className="group flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {policy.pattern}
              </span>
              <Select
                value={policy.action}
                onValueChange={(value) => props.onUpdate(policy, value as ToolPolicyAction)}
              >
                <SelectTrigger
                  className={cn(
                    "h-7 w-32 text-xs",
                    POLICY_BADGE_VARIANT[policy.action] === "destructive" &&
                      "border-destructive/30 text-destructive",
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLICY_ACTIONS_IN_ORDER.map((option) => (
                    <SelectItem key={option} value={option}>
                      {POLICY_ACTION_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${policy.pattern}`}
                onClick={() => void props.onRemove(policy)}
                className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolkitContentsEmpty(props: { onAddConnection: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
          <PlugIcon className="size-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-foreground">No connections added</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Add a connection to decide what this toolkit exposes.
        </p>
        <Button type="button" size="sm" onClick={props.onAddConnection} className="mt-4">
          <PlusIcon className="size-3.5" />
          Add connection
        </Button>
      </div>
    </div>
  );
}

function ToolkitContentsPanel(props: {
  groups: readonly ToolkitConnectionGroup[];
  includedToolIds: ReadonlySet<string>;
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  onAddConnection: () => void;
  onRemoveConnection: (group: ToolkitConnectionGroup) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Toolkit contents
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {props.groups.length} {props.groups.length === 1 ? "connection" : "connections"}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            aria-label="Add connection to toolkit"
            onClick={props.onAddConnection}
            className="h-8"
          >
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.groups.length === 0 ? (
          <div className="px-2 py-3 text-xs leading-5 text-muted-foreground">
            This toolkit is empty. Add a connection to make its tools available.
          </div>
        ) : (
          <div className="space-y-1.5">
            {props.groups.map((group) => (
              <ToolkitConnectionItem
                key={group.id}
                group={group}
                includedToolIds={props.includedToolIds}
                integrations={props.integrations}
                integrationPlugins={props.integrationPlugins}
                onRemoveConnection={() => props.onRemoveConnection(group)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolkitConnectionItem(props: {
  group: ToolkitConnectionGroup;
  includedToolIds: ReadonlySet<string>;
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  onRemoveConnection: () => void;
}) {
  const includedTools = props.group.tools.filter((tool) =>
    props.includedToolIds.has(toolMatchId(tool)),
  );
  const title = connectionTitle(props.group);
  const meta = integrationMetaFor(props.group, props.integrations, props.integrationPlugins);
  return (
    <div className="rounded-md border border-border/60 bg-card transition-colors hover:border-foreground/15">
      <div className="group flex items-start gap-2 p-2">
        <div className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30">
            <IntegrationFavicon
              icon={meta.icon}
              sourceId={meta.sourceId}
              url={meta.url}
              size={16}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {connectionDisplayTitle(props.group, meta)}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {connectionDisplaySubtitle(props.group, meta)}
            </span>
          </span>
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
            {ownerLabel(props.group.owner)}
          </Badge>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {includedTools.length}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove connection ${title}`}
          onClick={props.onRemoveConnection}
          className="mt-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AddConnectionDialog(props: {
  open: boolean;
  groups: readonly ToolkitConnectionGroup[];
  includedToolIds: ReadonlySet<string>;
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  onOpenChange: (open: boolean) => void;
  onAddPatterns: (patterns: readonly string[], action: ToolPolicyAction) => Promise<void> | void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!trimmedQuery) return props.groups;
    return props.groups.filter((group) => {
      const corpus = [
        connectionTitle(group),
        ...group.patterns,
        ownerLabel(group.owner),
        ...group.tools.flatMap((tool) => [tool.name, tool.description ?? ""]),
      ]
        .join(" ")
        .toLowerCase();
      return corpus.includes(trimmedQuery);
    });
  }, [props.groups, trimmedQuery]);

  const addAndClose = async (patterns: readonly string[]) => {
    await props.onAddPatterns(patterns, "approve");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden rounded-md border-border/80 bg-card p-0 shadow-2xl"
        style={{
          width: "min(36rem, calc(100vw - 2rem))",
          maxWidth: "min(36rem, calc(100vw - 2rem))",
          maxHeight: "min(42rem, calc(100vh - 4rem))",
        }}
      >
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
              <PlugIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm">Add connection</DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                Choose which connected account this toolkit can use.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border/50 p-3">
            <Label htmlFor={searchId} className="sr-only">
              Search connections and tools
            </Label>
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 transition-colors focus-within:border-primary/35 focus-within:bg-muted/25 focus-within:ring-1 focus-within:ring-primary/15">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                className="h-8 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              />
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto p-3" style={{ maxHeight: "32rem" }}>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Connections
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {filteredGroups.length}
              </span>
            </div>
            {filteredGroups.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
                No connections match.
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/70 bg-background/30">
                {filteredGroups.map((group) => {
                  const title = connectionTitle(group);
                  const added = group.tools.every((tool) =>
                    props.includedToolIds.has(toolMatchId(tool)),
                  );
                  const meta = integrationMetaFor(
                    group,
                    props.integrations,
                    props.integrationPlugins,
                  );
                  return (
                    <div
                      key={group.id}
                      className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0 hover:bg-muted/20"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30">
                        <IntegrationFavicon
                          icon={meta.icon}
                          sourceId={meta.sourceId}
                          url={meta.url}
                          size={18}
                        />
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium text-foreground">
                            {connectionDisplayTitle(group, meta)}
                          </span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {ownerLabel(group.owner)}
                          </Badge>
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[11px] text-muted-foreground">
                            {connectionDisplaySubtitle(group, meta)}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant={added ? "outline" : "default"}
                        size="sm"
                        disabled={added}
                        aria-label={`${added ? "Connection added" : "Add connection"} ${title}`}
                        onClick={() => void addAndClose(group.patterns)}
                        className={cn(
                          "h-7 shrink-0 px-2.5 text-xs",
                          added
                            ? "border-border/70 bg-transparent text-muted-foreground"
                            : "bg-primary/10 text-primary hover:bg-primary/15",
                        )}
                      >
                        {added ? (
                          <CheckIcon className="size-3.5" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        {added ? "Added" : "Add"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolkitHeader(props: {
  toolkit: ToolkitResponse;
  toolCount: number;
  mcpUrl: string;
  onBack: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={props.onBack}
        className="mb-2 -ml-1 text-muted-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        Toolkits
      </Button>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{props.toolkit.name}</h2>
            <Badge variant="outline" className="text-[10px]">
              {ownerLabel(props.toolkit.owner)}
            </Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              {props.toolCount} {props.toolCount === 1 ? "tool" : "tools"}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <code className="min-w-0 truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {props.mcpUrl}
            </code>
            <CopyButton value={props.mcpUrl} label="Copy toolkit MCP URL" />
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete toolkit"
          onClick={props.onRemove}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ToolkitWorkspace(props: {
  toolkit: ToolkitResponse;
  policies: readonly ToolkitPolicyResponse[];
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  mcpUrl: string;
  onBack: () => void;
  onRemoveToolkit: () => void;
  onSetPolicy: (pattern: string, action: ToolPolicyAction) => Promise<void> | void;
  onClearPolicy: (pattern: string) => Promise<void> | void;
  onUpdatePolicy: (policy: ToolkitPolicyResponse, action: ToolPolicyAction) => Promise<void> | void;
  onRemovePolicy: (policy: ToolkitPolicyResponse) => Promise<void> | void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const visibleTools = useMemo(
    () => props.tools.filter((tool) => toolCanAppearInToolkit(props.toolkit, tool)),
    [props.toolkit, props.tools],
  );
  const connectionGroups = useMemo(() => buildConnectionGroups(visibleTools), [visibleTools]);
  const includedToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of visibleTools) {
      const id = toolMatchId(tool);
      if (resolveToolkitPolicy(id, props.policies).action !== "block") ids.add(id);
    }
    return ids;
  }, [visibleTools, props.policies]);
  const includedGroups = useMemo(
    () =>
      connectionGroups.filter((group) =>
        group.tools.some((tool) => includedToolIds.has(toolMatchId(tool))),
      ),
    [connectionGroups, includedToolIds],
  );
  const includedTools = useMemo(
    () => visibleTools.filter((tool) => includedToolIds.has(toolMatchId(tool))).sort(compareTools),
    [visibleTools, includedToolIds],
  );
  const toolkitTools: ToolSummary[] = useMemo(
    () =>
      includedTools.map((tool) => {
        const id = toolMatchId(tool);
        return {
          id,
          name: id,
          description: tool.description,
          policy: resolveToolkitPolicy(id, props.policies),
          owner: toolOwner(tool),
          connection: toolConnectionName(tool),
        };
      }),
    [includedTools, props.policies],
  );
  const selectedTool = selectedToolId
    ? (includedTools.find((tool) => toolMatchId(tool) === selectedToolId) ?? null)
    : null;
  const selectedToolPolicy = selectedTool
    ? (toolkitTools.find((tool) => tool.id === selectedToolId)?.policy ?? null)
    : null;

  const removeConnection = async (group: ToolkitConnectionGroup) => {
    for (const pattern of group.patterns) {
      const exact = policyForExactPattern(props.policies, pattern);
      if (exact && exact.action !== "block") {
        await props.onClearPolicy(pattern);
      } else {
        await props.onSetPolicy(pattern, "block");
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ToolkitHeader
        toolkit={props.toolkit}
        toolCount={includedToolIds.size}
        mcpUrl={props.mcpUrl}
        onBack={props.onBack}
        onRemove={props.onRemoveToolkit}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="flex shrink-0 flex-col border-r border-border/60"
          style={toolkitConnectionSidebarStyle}
        >
          <ToolkitContentsPanel
            groups={includedGroups}
            includedToolIds={includedToolIds}
            integrations={props.integrations}
            integrationPlugins={props.integrationPlugins}
            onAddConnection={() => setAddOpen(true)}
            onRemoveConnection={(group) => void removeConnection(group)}
          />
          <ToolkitRules
            policies={props.policies}
            onUpdate={props.onUpdatePolicy}
            onRemove={props.onRemovePolicy}
          />
          <ToolkitRuleForm onCreate={props.onSetPolicy} />
        </div>

        <div className="flex min-w-0 flex-1 overflow-hidden">
          {toolkitTools.length > 0 ? (
            <>
              <div
                role="region"
                aria-label="Toolkit tools"
                className="flex shrink-0 flex-col border-r border-border/60"
                style={toolkitToolTreeStyle}
              >
                <ToolTree
                  tools={toolkitTools}
                  selectedToolId={selectedToolId}
                  onSelect={setSelectedToolId}
                  onSetPolicy={(pattern, action) => void props.onSetPolicy(pattern, action)}
                  onClearPolicy={(pattern) => void props.onClearPolicy(pattern)}
                  patternForDisplay={identityPattern}
                  policies={props.policies}
                  groupByConnection
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {selectedTool && selectedToolPolicy ? (
                  <ToolDetail
                    address={selectedTool.address}
                    toolName={toolMatchId(selectedTool)}
                    staticTool={selectedTool.static === true}
                    policy={selectedToolPolicy}
                    onSetPolicy={props.onSetPolicy}
                    onClearPolicy={props.onClearPolicy}
                    patternForDisplay={identityPattern}
                  />
                ) : (
                  <ToolDetailEmpty hasTools={toolkitTools.length > 0} />
                )}
              </div>
            </>
          ) : (
            <ToolkitContentsEmpty onAddConnection={() => setAddOpen(true)} />
          )}
        </div>
      </div>

      <AddConnectionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groups={connectionGroups}
        includedToolIds={includedToolIds}
        integrations={props.integrations}
        integrationPlugins={props.integrationPlugins}
        onAddPatterns={async (patterns, action) => {
          for (const pattern of patterns) {
            await props.onSetPolicy(pattern, action);
          }
        }}
      />
    </div>
  );
}

function ToolkitsPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex-1 p-4">
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-36 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolkitDetailView(props: {
  toolkit: ToolkitResponse;
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  orgSlug?: string;
  onBack: () => void;
  onRemoveToolkit: (toolkit: ToolkitResponse) => void;
}) {
  const policies = useAtomValue(toolkitPoliciesAtom(props.toolkit.id));
  const doCreatePolicy = useAtomSet(createToolkitPolicy, { mode: "promiseExit" });
  const doUpdatePolicy = useAtomSet(updateToolkitPolicy, { mode: "promiseExit" });
  const doRemovePolicy = useAtomSet(removeToolkitPolicy, { mode: "promiseExit" });
  const policyRows = AsyncResult.isSuccess(policies) ? policies.value.policies : [];

  const setPolicyHandler = async (pattern: string, action: ToolPolicyAction) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (existing) {
      await doUpdatePolicy({
        params: { toolkitId: props.toolkit.id, policyId: existing.id },
        payload: { action },
        reactivityKeys: toolkitWriteKeys,
      });
      return;
    }
    await doCreatePolicy({
      params: { toolkitId: props.toolkit.id },
      payload: { pattern, action },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const clearPolicyHandler = async (pattern: string) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (!existing) return;
    await doRemovePolicy({
      params: { toolkitId: props.toolkit.id, policyId: existing.id },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const updatePolicyHandler = async (policy: ToolkitPolicyResponse, action: ToolPolicyAction) => {
    await doUpdatePolicy({
      params: { toolkitId: props.toolkit.id, policyId: policy.id },
      payload: { action },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removePolicyHandler = async (policy: ToolkitPolicyResponse) => {
    await doRemovePolicy({
      params: { toolkitId: props.toolkit.id, policyId: policy.id },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  if (AsyncResult.isFailure(policies)) {
    return <div className="p-6 text-sm text-destructive">Failed to load toolkit rules</div>;
  }
  if (!AsyncResult.isSuccess(policies)) return <ToolkitsPageSkeleton />;

  return (
    <ToolkitWorkspace
      toolkit={props.toolkit}
      policies={policyRows}
      tools={props.tools}
      integrations={props.integrations}
      integrationPlugins={props.integrationPlugins}
      mcpUrl={toolkitUrlFor(props.orgSlug, props.toolkit.slug)}
      onBack={props.onBack}
      onRemoveToolkit={() => props.onRemoveToolkit(props.toolkit)}
      onSetPolicy={setPolicyHandler}
      onClearPolicy={clearPolicyHandler}
      onUpdatePolicy={updatePolicyHandler}
      onRemovePolicy={removePolicyHandler}
    />
  );
}

export function ToolkitsPage(props: PluginPageProps) {
  const params = useParams({ strict: false }) as { orgSlug?: string };
  const navigate = useNavigate();
  const integrationPlugins = useIntegrationPlugins();
  const toolkits = useAtomValue(toolkitsAtom);
  const tools = useAtomValue(toolsAllAtom);
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const doCreateToolkit = useAtomSet(createToolkit, { mode: "promiseExit" });
  const doRemoveToolkit = useAtomSet(removeToolkit, { mode: "promiseExit" });
  const selectedToolkitSlug = props.params.toolkitSlug ?? null;

  const toolkitRows = AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [];
  const selectedToolkit =
    selectedToolkitSlug === null
      ? null
      : (toolkitRows.find((toolkit) => toolkit.slug === selectedToolkitSlug) ?? null);

  const toolRows = AsyncResult.isSuccess(tools) ? (tools.value as readonly ToolRow[]) : [];
  const integrationRows = AsyncResult.isSuccess(integrations)
    ? (integrations.value as readonly Integration[])
    : [];
  const navigateToIndex = () =>
    navigate({
      to: "/{-$orgSlug}/plugins/$pluginId/$",
      params: { pluginId: props.pluginId, _splat: "" },
    });

  const createToolkitHandler = async (input: { owner: Owner; name: string }) => {
    await doCreateToolkit({
      payload: input,
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removeToolkitHandler = async (toolkit: ToolkitResponse) => {
    await doRemoveToolkit({
      params: { toolkitId: toolkit.id },
      reactivityKeys: toolkitWriteKeys,
    });
    await navigateToIndex();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {selectedToolkitSlug === null ? (
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-sm font-semibold text-foreground">Toolkits</h1>
            {AsyncResult.isSuccess(toolkits) && (
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
                {toolkitRows.length} {toolkitRows.length === 1 ? "toolkit" : "toolkits"}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {!AsyncResult.isSuccess(toolkits) || !AsyncResult.isSuccess(tools) ? (
        AsyncResult.isFailure(toolkits) || AsyncResult.isFailure(tools) ? (
          <div className="p-6 text-sm text-destructive">Failed to load toolkits</div>
        ) : (
          <ToolkitsPageSkeleton />
        )
      ) : (
        <>
          {selectedToolkit ? (
            <ToolkitDetailView
              toolkit={selectedToolkit}
              tools={toolRows}
              integrations={integrationRows}
              integrationPlugins={integrationPlugins}
              orgSlug={params.orgSlug}
              onBack={() => void navigateToIndex()}
              onRemoveToolkit={removeToolkitHandler}
            />
          ) : selectedToolkitSlug !== null ? (
            <div className="flex min-h-0 flex-1 flex-col p-6">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void navigateToIndex()}
                className="mb-4 w-fit -ml-1 text-muted-foreground"
              >
                <ArrowLeftIcon className="size-3.5" />
                Toolkits
              </Button>
              <div className="text-sm text-muted-foreground">Toolkit not found</div>
            </div>
          ) : (
            <ToolkitGrid
              pluginId={props.pluginId}
              toolkits={toolkitRows}
              onCreate={createToolkitHandler}
            />
          )}
        </>
      )}
    </div>
  );
}
