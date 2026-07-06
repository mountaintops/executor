import { join } from "node:path";

import { Effect } from "effect";

import {
  appsPlugin,
  BindingError,
  makeSelfHostAppsRuntime,
  makeSqliteAppsStore,
  type AppsRuntime,
  type ClientResolver,
} from "@executor-js/plugin-apps/api";
import type { PluginCtx } from "@executor-js/sdk";

import { resolveDataDir } from "./config";
import { makeSelfHostAppsResolver } from "./apps-resolver";

const missingResolver = (): ClientResolver => ({
  listConnections: () => Effect.succeed([]),
  resolveConnection: () => Effect.succeed(null),
  call: ({ integration, connection }) =>
    Effect.fail(
      new BindingError({
        role: integration,
        integration,
        requestedConnection: connection,
        message: "apps resolver is unavailable outside a request-scoped executor",
      }),
    ),
});

const createSubsystem = (dataDir: string) => {
  const appsDir = join(dataDir, "apps");
  const store = makeSqliteAppsStore({ path: join(appsDir, "store.sqlite") });
  const host = makeSelfHostAppsRuntime({
    dataDir: appsDir,
    store,
    resolver: missingResolver(),
  });
  const plugin = appsPlugin({
    runtime: host.runtime,
    makeResolver: ({ ctx }) => makeSelfHostAppsResolver({ ctx: ctx as PluginCtx }),
  });
  return {
    runtime: host.runtime,
    plugin,
    close: host.close,
  };
};

export interface SelfHostAppsSubsystem {
  readonly runtime: AppsRuntime;
  readonly plugin: ReturnType<typeof appsPlugin>;
  readonly close: () => Promise<void>;
}

let current: { readonly dataDir: string; readonly subsystem: SelfHostAppsSubsystem } | undefined;

export const getSelfHostAppsSubsystem = (): SelfHostAppsSubsystem => {
  const dataDir = resolveDataDir();
  if (current && current.dataDir === dataDir) return current.subsystem;
  const subsystem = createSubsystem(dataDir);
  current = { dataDir, subsystem };
  return subsystem;
};

export const closeSelfHostAppsSubsystem = async (): Promise<void> => {
  const subsystem = current?.subsystem;
  current = undefined;
  await subsystem?.close();
};
