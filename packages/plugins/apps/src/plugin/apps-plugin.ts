import { Effect } from "effect";

import {
  definePlugin,
  ToolName,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type InvokeToolInput,
  type ToolDef,
} from "@executor-js/sdk";

import type { AppsRuntime } from "./runtime";
import { makeAppsStore } from "./store";
import type { Bindings, ClientResolver } from "./bindings";

// ---------------------------------------------------------------------------
// The apps source plugin. Published custom tools become catalog citizens: the
// plugin registers one integration per scope (`apps`), and a connection to it
// makes the published tools resolvable + invocable like any catalog tool, so
// policy / approval / audit / toolkits / tools.list all apply unchanged.
//
// `resolveTools` projects the published descriptor into `ToolDef[]`.
// `invokeTool` bundles + runs the tool in the sandbox with connections bound.
// The plugin is thin: all logic lives in `AppsRuntime` (shared with the HTTP +
// MCP surfaces). The runtime is supplied via options because it owns the seam
// instances built at host boot.
// ---------------------------------------------------------------------------

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

export interface AppsPluginOptions {
  /** The shared runtime (seams + store). Built at host boot. */
  readonly runtime: AppsRuntime;
  /** How a tool's declared connection roles are bound to the caller's
   *  connections at invoke time. Self-host resolves these from the scope's
   *  configured connections; a default binds each role to a connection of the
   *  same name as the integration. */
  readonly resolveBindings?: (input: {
    readonly scope: string;
    readonly tool: string;
    readonly declared: Readonly<Record<string, { kind: string; integration?: string }>>;
  }) => Bindings;
  /** Build a per-request ClientResolver from the invoking executor context.
   *  This is how external integration calls route through the REAL per-request
   *  path (connections resolved by the invoking owner, credentials injected at
   *  the boundary), rather than the runtime's boot-time default resolver. The
   *  `ctx` is the plugin's per-request `PluginCtx`; the type is kept structural
   *  so this package does not depend on the host SDK's ctx shape. */
  readonly makeResolver?: (input: {
    readonly ctx: unknown;
    readonly scope: string;
    readonly tool: string;
  }) => ClientResolver;
}

const defaultBindings = (
  declared: Readonly<Record<string, { kind: string; integration?: string }>>,
): Bindings => {
  const out: Record<string, Bindings[string]> = {};
  for (const [role, decl] of Object.entries(declared)) {
    if (decl.kind === "array") {
      out[role] = { kind: "array", connections: [decl.integration ?? role] };
    } else if (decl.kind === "catalog") {
      // no binding
    } else {
      out[role] = { kind: "single", connection: decl.integration ?? role };
    }
  }
  return out;
};

interface AppsStoreShape {
  readonly runtime: AppsRuntime;
}

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => {
  if (!options?.runtime) {
    throw new Error("appsPlugin requires a `runtime` (built from the five seams at host boot)");
  }
  const runtime = options.runtime;
  const resolveBindings = options.resolveBindings;
  const makeResolver = options.makeResolver;

  return {
    id: APPS_PLUGIN_ID as "apps",
    packageName: "@executor-js/plugin-apps",

    // The plugin's store facade is host-owned plugin storage + blobs; the apps
    // runtime already holds its own store, so this is a thin passthrough kept
    // for the ctx shape (extension methods read the runtime).
    storage: (deps): AppsStoreShape => {
      void makeAppsStore({
        pluginStorage: deps.pluginStorage,
        blobs: deps.blobs,
      });
      return { runtime };
    },

    // Declare the plugin's storage collection so the host provisions it.
    pluginStorage: {
      published_descriptor: {
        name: "published_descriptor",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
    },

    extension: () => ({ runtime }),

    // Per-connection tool production: project the published descriptor into
    // ToolDefs. Called at connection create/refresh; the SDK stamps addresses
    // and persists per connection.
    resolveTools: ({ connection }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        // The connection name encodes the scope via the formalized mapping
        // (`apps/<scope>`). A scope with no published app yet legitimately
        // resolves to ZERO tools (the connection exists before the first
        // publish), so an empty descriptor here is an intentional empty result,
        // not the silently-swallowed missing-tool case invokeTool guards against.
        const scope = scopeFromConnection(connection.name);
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) return { tools: [] } satisfies ResolveToolsResult;
        const tools: ToolDef[] = descriptor.tools.map((t) => ({
          name: ToolName.make(t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: {
            requiresApproval: t.annotations?.destructive === true,
          },
        }));
        return { tools } satisfies ResolveToolsResult;
      }),

    invokeTool: ({ ctx, toolRow, args }: InvokeToolInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const scope = scopeFromConnection(toolRow.connection);
        const descriptor = yield* runtime.getDescriptor(scope);
        // A missing descriptor / unknown tool is a typed error, NOT a silent
        // `?? {}` default: invoking a tool that is not published in the scope
        // must fail loudly rather than run with empty connections.
        if (!descriptor) {
          return yield* Effect.fail(
            new Error(
              `apps scope "${scope}" has no published app (connection "${toolRow.connection}")`,
            ),
          );
        }
        const toolDesc = descriptor.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) {
          return yield* Effect.fail(
            new Error(`apps tool "${toolRow.name}" is not published in scope "${scope}"`),
          );
        }
        const declared = toolDesc.connections;
        const bindings = resolveBindings
          ? resolveBindings({ scope, tool: toolRow.name, declared })
          : defaultBindings(declared);
        // Build the per-request resolver from the invoking executor context so
        // external calls route through the real per-request path (connections +
        // credentials resolved at the boundary). Falls back to the runtime's
        // boot-time resolver when the host supplies no factory.
        const resolver = makeResolver
          ? makeResolver({ ctx, scope, tool: toolRow.name })
          : undefined;
        return yield* runtime
          .invokeTool({ scope, tool: toolRow.name, args, bindings, resolver })
          .pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  "message" in cause && typeof cause.message === "string"
                    ? cause.message
                    : "apps tool invocation failed",
                ),
            ),
          );
      }),
  };
});

// ---------------------------------------------------------------------------
// Formalized scope <-> connection mapping. An apps connection is named
// `apps/<scope>` (integration-prefixed), so the scope is the segment after the
// first slash. A bare name (no slash) IS the scope (self-host single-tenant,
// where the sole connection is named for its scope). This is the ONE place the
// mapping lives; resolveTools and invokeTool both go through it.
// ---------------------------------------------------------------------------
export const APPS_CONNECTION_PREFIX = `${APPS_INTEGRATION_SLUG}/`;

/** The connection name that addresses a scope's published app. */
export const connectionNameForScope = (scope: string): string =>
  `${APPS_CONNECTION_PREFIX}${scope}`;

/** The scope a connection name addresses (inverse of `connectionNameForScope`). */
export const scopeFromConnection = (connectionName: string): string => {
  if (connectionName.startsWith(APPS_CONNECTION_PREFIX)) {
    return connectionName.slice(APPS_CONNECTION_PREFIX.length);
  }
  const slash = connectionName.indexOf("/");
  return slash === -1 ? connectionName : connectionName.slice(slash + 1);
};
