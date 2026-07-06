import { Effect, Result } from "effect";

import {
  definePlugin,
  tool,
  ToolName,
  IntegrationSlug,
  AuthTemplateSlug,
  connectionIdentifier,
  ProviderItemId,
  ProviderKey,
  type PluginCtx,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type InvokeToolInput,
  type ToolDef,
} from "@executor-js/sdk";

import type { AppsRuntime } from "./runtime";
import { makeAppsStore } from "./store";
import type { ClientResolver, ConnectionCandidate } from "./bindings";
import type { IntegrationDecl, ToolDescriptor } from "../pipeline/descriptor";
import { PublishError } from "../pipeline/discover";
import {
  parseGitHubSourceUrl,
  syncGitHubSource,
  type GitHubSyncResult,
} from "../source/github-source";

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

const DEFAULT_CATALOG_SCOPE = "default";

export interface AppsPluginOptions {
  readonly runtime: AppsRuntime;
  readonly makeResolver?: (input: {
    readonly ctx: unknown;
    readonly scope: string;
    readonly tool: string;
  }) => ClientResolver;
}

interface AppsStoreShape {
  readonly runtime: AppsRuntime;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const syncFailure = (message: string, path?: string): GitHubSyncResult => ({
  status: "failed",
  tools: [],
  skipped: [],
  errors: [
    {
      stage: "source",
      message,
      ...(path ? { diagnostics: [{ path, message }] } : {}),
    },
  ],
});

const sourceScopeFor = (repo: string): string =>
  String(connectionIdentifier(`github ${repo}`, "githubSource"));

const sourceTokenItemId = (tenant: string, scope: string): ProviderItemId =>
  ProviderItemId.make(`apps:github-source:${tenant}:${scope}:token`);

const configBaseUrl = (config: unknown): string | undefined =>
  isRecord(config) && typeof config.baseUrl === "string" && config.baseUrl.length > 0
    ? config.baseUrl
    : undefined;

const projectInputSchema = (
  schema: unknown,
  integrations: Readonly<Record<string, IntegrationDecl>>,
  byRole: Readonly<Record<string, readonly ConnectionCandidate[]>>,
): unknown => {
  const base: Record<string, unknown> = isRecord(schema) ? { ...schema } : { type: "object" };
  const properties = isRecord(base.properties) ? { ...base.properties } : {};
  const required = new Set(
    Array.isArray(base.required)
      ? base.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  for (const [role, decl] of Object.entries(integrations)) {
    const addresses = unique((byRole[role] ?? []).map((c) => c.address));
    const roleSchema: Record<string, unknown> = {
      type: "string",
      enum: addresses,
      description: `Connection to use for ${role} (${decl.integration})`,
    };
    if (addresses.length === 1) {
      roleSchema.default = addresses[0];
      required.delete(role);
    } else {
      required.add(role);
    }
    properties[role] = roleSchema;
  }

  const projected: Record<string, unknown> = {
    ...base,
    type: typeof base.type === "string" ? base.type : "object",
    properties,
  };
  if (required.size > 0) projected.required = [...required];
  else delete projected.required;
  return projected;
};

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => {
  const runtime = options?.runtime as AppsRuntime;
  const makeResolver = options?.makeResolver;

  const tenantFor = (ctx: Pick<PluginCtx, "owner"> | undefined): string => {
    const tenant = ctx?.owner?.tenant;
    return tenant === undefined ? "org" : String(tenant);
  };

  const scopeFor = (tenant: string, connectionName: string): Effect.Effect<string> =>
    runtime.deps.store.getScopeForConnection(tenant, connectionName).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((mapped) => mapped ?? scopeFromConnection(connectionName)),
    );

  const storeSourceToken = (
    ctx: PluginCtx<AppsStoreShape>,
    tenant: string,
    scope: string,
    token: string,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const itemId = sourceTokenItemId(tenant, scope);
      const provider = yield* ctx.providers.setDefault(itemId, token).pipe(Effect.result);
      if (Result.isFailure(provider)) return false;
      const stored = yield* runtime.deps.store
        .putGitHubSourceTokenRef(tenant, scope, {
          provider: String(provider.success),
          itemId: String(itemId),
          updatedAt: Date.now(),
        })
        .pipe(Effect.result);
      return Result.isSuccess(stored);
    });

  const storedSourceToken = (
    ctx: PluginCtx<AppsStoreShape>,
    tenant: string,
    scope: string,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const ref = yield* runtime.deps.store
        .getGitHubSourceTokenRef(tenant, scope)
        .pipe(Effect.orElseSucceed(() => null));
      if (!ref) return null;
      return yield* ctx.providers
        .get(ProviderKey.make(ref.provider), ProviderItemId.make(ref.itemId))
        .pipe(Effect.orElseSucceed(() => null));
    });

  const ensureCatalogConnection = (scope: string, ctx: PluginCtx<AppsStoreShape>) =>
    Effect.gen(function* () {
      const tenant = tenantFor(ctx);
      const slug = IntegrationSlug.make(APPS_INTEGRATION_SLUG);
      const existing = yield* ctx.core.integrations
        .get(slug)
        .pipe(Effect.orElseSucceed(() => null));
      if (!existing) {
        yield* ctx.core.integrations.register({
          slug,
          name: "Apps",
          description: "User-authored, published custom tools.",
          config: {},
          canRemove: false,
          canRefresh: true,
        });
      }
      const rawName = connectionNameForScope(scope);
      const connName = connectionIdentifier(rawName);
      const conns = yield* ctx.connections
        .list({ integration: slug })
        .pipe(Effect.orElseSucceed(() => []));
      if (!conns.some((c) => String(c.name) === String(connName))) {
        yield* ctx.connections.create({
          owner: "user",
          name: connName,
          integration: slug,
          template: AuthTemplateSlug.make("none"),
          value: "",
        });
      }
      yield* runtime.deps.store
        .putScopeForConnection(tenant, String(rawName), scope)
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* runtime.deps.store
        .putScopeForConnection(tenant, String(connName), scope)
        .pipe(Effect.orElseSucceed(() => undefined));
      return {
        scope,
        connection: String(connName),
        ref: { owner: "user" as const, integration: slug, name: connName },
      };
    });

  return {
    id: APPS_PLUGIN_ID as "apps",
    packageName: "@executor-js/plugin-apps",

    storage: (deps): AppsStoreShape => {
      void makeAppsStore({
        pluginStorage: deps.pluginStorage,
      });
      return { runtime };
    },

    pluginStorage: {
      published_descriptor: {
        name: "published_descriptor",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
      apps_scope_connection: {
        name: "apps_scope_connection",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
      apps_github_source_token: {
        name: "apps_github_source_token",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
    },

    extension: () => ({ runtime }),

    staticSources: () => [
      {
        id: APPS_PLUGIN_ID,
        kind: "executor",
        name: "Apps",
        tools: [
          tool<AppsStoreShape>({
            name: "connect_catalog",
            description:
              "Wire this scope's published custom tools into the tool catalog. " +
              "Idempotent; call once per scope after publishing.",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                const scope =
                  (args as { scope?: string } | undefined)?.scope ?? DEFAULT_CATALOG_SCOPE;
                const connected = yield* ensureCatalogConnection(scope, ctx);
                return { scope, connection: connected.connection };
              }),
          }),
          tool<AppsStoreShape>({
            name: "sync_github_source",
            description: "Sync a GitHub repository containing custom tool source files.",
            execute: (args, { ctx }) =>
              Effect.gen(function* () {
                const payload = isRecord(args) ? args : {};
                const url =
                  typeof payload.url === "string"
                    ? payload.url
                    : typeof payload.repo === "string"
                      ? payload.repo
                      : "";
                const ref =
                  typeof payload.ref === "string" && payload.ref.trim().length > 0
                    ? payload.ref.trim()
                    : undefined;
                const providedToken =
                  typeof payload.token === "string" && payload.token.trim().length > 0
                    ? payload.token.trim()
                    : null;
                const explicitScope = typeof payload.scope === "string" ? payload.scope : undefined;
                if (!url) return syncFailure('sync_github_source requires "url"');

                const parsed = parseGitHubSourceUrl(url, { ref });
                if (!parsed.ok) return syncFailure(parsed.message, url);
                const integration = yield* ctx.core.integrations
                  .get(IntegrationSlug.make("github"))
                  .pipe(Effect.orElseSucceed(() => null));
                const tenant = tenantFor(ctx);
                const scope = explicitScope ?? sourceScopeFor(parsed.value.repo);
                if (providedToken) {
                  const stored = yield* storeSourceToken(ctx, tenant, scope, providedToken);
                  if (!stored) {
                    return syncFailure(
                      "No writable credential provider is available to store the GitHub source token.",
                    );
                  }
                }
                const token = providedToken ?? (yield* storedSourceToken(ctx, tenant, scope));
                const result = yield* syncGitHubSource({
                  runtime,
                  tenant,
                  scope,
                  url,
                  ref,
                  token,
                  baseUrl: configBaseUrl(integration?.config),
                });
                if (result.status === "published") {
                  const catalog = yield* ensureCatalogConnection(scope, ctx);
                  yield* ctx.connections.refresh(catalog.ref).pipe(Effect.orElseSucceed(() => []));
                }
                return result;
              }),
          }),
          tool<AppsStoreShape>({
            name: "list_github_sources",
            description: "List synced GitHub repositories that publish custom tools.",
            execute: (_args, { ctx }) =>
              Effect.gen(function* () {
                const tenant = tenantFor(ctx);
                const sources = yield* runtime.listGitHubSources(tenant);
                return { sources };
              }),
          }),
        ],
      },
    ],

    resolveTools: ({ ctx, connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const tenant = ctx ? tenantFor(ctx) : "org";
        const scope = yield* scopeFor(tenant, String(connection.name));
        const descriptor = yield* runtime.getDescriptor(tenant, scope);
        if (!descriptor) return { tools: [] } satisfies ResolveToolsResult;
        const tools: ToolDef[] = [];
        for (const t of descriptor.tools) {
          tools.push(projectTool(t));
        }
        return { tools } satisfies ResolveToolsResult;
      }),

    projectToolSchema: ({ ctx, toolRow, inputSchema, outputSchema }) =>
      Effect.gen(function* () {
        const tenant = tenantFor(ctx);
        const scope = yield* scopeFor(tenant, String(toolRow.connection));
        const descriptor = yield* runtime.getDescriptor(tenant, scope);
        const toolDesc = descriptor?.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) return { inputSchema, outputSchema };
        const resolver = makeResolver
          ? makeResolver({ ctx, scope, tool: toolRow.name })
          : runtime.deps.resolver;
        const byRole: Record<string, readonly ConnectionCandidate[]> = {};
        for (const [role, decl] of Object.entries(toolDesc.integrations)) {
          byRole[role] = yield* resolver
            .listConnections({ integration: decl.integration })
            .pipe(Effect.orElseSucceed(() => []));
        }
        return {
          inputSchema: projectInputSchema(toolDesc.inputSchema, toolDesc.integrations, byRole),
          outputSchema: toolDesc.outputSchema,
        };
      }),

    invokeTool: ({ ctx, toolRow, args, invokeOptions }: InvokeToolInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const tenant = tenantFor(ctx);
        const scope = yield* scopeFor(tenant, String(toolRow.connection));
        const descriptor = yield* runtime.getDescriptor(tenant, scope);
        if (!descriptor) {
          return yield* new PublishError({
            message: `apps scope "${scope}" has no published app (connection "${toolRow.connection}")`,
            stage: "project",
            diagnostics: [],
          });
        }
        const toolDesc = descriptor.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) {
          return yield* new PublishError({
            message: `apps tool "${toolRow.name}" is not published in scope "${scope}"`,
            stage: "project",
            diagnostics: [],
          });
        }
        const resolver = makeResolver
          ? makeResolver({ ctx, scope, tool: toolRow.name })
          : undefined;
        return yield* runtime.invokeTool({
          tenant,
          scope,
          tool: toolRow.name,
          args,
          resolver,
          invokeOptions,
        });
      }),
  };
});

const projectTool = (descriptor: ToolDescriptor): ToolDef => ({
  name: ToolName.make(descriptor.name),
  description: descriptor.description,
  inputSchema: descriptor.inputSchema,
  outputSchema: descriptor.outputSchema,
  annotations: {
    requiresApproval: descriptor.annotations?.destructive === true,
  },
});

export const APPS_CONNECTION_PREFIX = APPS_INTEGRATION_SLUG;

const pascal = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

export const connectionNameForScope = (scope: string): string =>
  `${APPS_CONNECTION_PREFIX}${pascal(scope)}`;

export const scopeFromConnection = (connectionName: string): string => {
  if (connectionName.startsWith(`${APPS_INTEGRATION_SLUG}/`)) {
    return connectionName.slice(APPS_INTEGRATION_SLUG.length + 1);
  }
  if (
    connectionName.startsWith(APPS_CONNECTION_PREFIX) &&
    connectionName.length > APPS_CONNECTION_PREFIX.length
  ) {
    const rest = connectionName.slice(APPS_CONNECTION_PREFIX.length);
    return `${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  const slash = connectionName.indexOf("/");
  return slash === -1 ? connectionName : connectionName.slice(slash + 1);
};
