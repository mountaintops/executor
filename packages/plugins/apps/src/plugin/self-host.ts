import { join } from "node:path";

import { makeSqliteAppsStore } from "../backing/sqlite-apps-store";
import { makeAppsHttpRoutes } from "../http/routes";
import { registerAppsMcp, type McpServerLike } from "../mcp/register";
import type { ClientResolver } from "./bindings";
import { makeSelfHostAppsRuntime, type SelfHostAppsRuntime } from "./self-host-runtime";
import { appsPlugin, type AppsPluginOptions } from "./apps-plugin";

// ---------------------------------------------------------------------------
// One-call self-host wiring for the apps subsystem: build the runtime over the
// five seam backings rooted at a data dir, a SQLite-backed metadata store, and
// a ClientResolver; return the HTTP route handler, an MCP registrar, the
// configured plugin, and a close hook. The self-host app calls this at boot and
// mounts the pieces.
// ---------------------------------------------------------------------------

export interface SelfHostAppsOptions {
  /** Data dir root for artifacts / scope-db / workflows / metadata. */
  readonly dataDir: string;
  /** Routes bound integration calls to real APIs (the executor invoke path).
   *  The boot-time default (used when no per-request `makeResolver` is given). */
  readonly resolver: ClientResolver;
  /** The single scope this self-host instance serves (single-tenant). */
  readonly scope: string;
  /** Optional binding resolution for the plugin's catalog invoke path. */
  readonly resolveBindings?: AppsPluginOptions["resolveBindings"];
  /** Optional per-request resolver factory for the catalog invoke path (built
   *  from the invoking executor context). */
  readonly makeResolver?: AppsPluginOptions["makeResolver"];
}

export interface SelfHostApps {
  readonly runtime: SelfHostAppsRuntime["runtime"];
  /** Extension route: `{ path: "/api/apps/*", handler }`. */
  readonly http: ReturnType<typeof makeAppsHttpRoutes>;
  /** Register the apps MCP tools/resources onto an McpServer. */
  readonly registerMcp: (server: McpServerLike) => void;
  /** The configured source plugin (add to the executor plugin tuple). */
  readonly plugin: ReturnType<typeof appsPlugin>;
  readonly close: () => Promise<void>;
}

export const makeSelfHostApps = (options: SelfHostAppsOptions): SelfHostApps => {
  const store = makeSqliteAppsStore({ path: join(options.dataDir, "apps", "metadata.db") });
  const host = makeSelfHostAppsRuntime({
    dataDir: options.dataDir,
    store,
    resolver: options.resolver,
  });
  const http = makeAppsHttpRoutes({ runtime: host.runtime });
  const plugin = appsPlugin({
    runtime: host.runtime,
    resolveBindings: options.resolveBindings,
    makeResolver: options.makeResolver,
  });
  return {
    runtime: host.runtime,
    http,
    registerMcp: (server) =>
      registerAppsMcp(server, { runtime: host.runtime, scope: options.scope }),
    plugin,
    close: host.close,
  };
};
