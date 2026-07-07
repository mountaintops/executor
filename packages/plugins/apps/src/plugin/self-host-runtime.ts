import { join } from "node:path";

import { makeGitArtifactStore } from "../backing/git-artifact-store";
import { makeQuickjsToolSandbox } from "../backing/quickjs-tool-sandbox";
import { type AppsRuntime } from "./runtime";
import type { AppsStore } from "./store";
import type { ClientResolver } from "./bindings";
import { makeAppsRuntimeFromBackings, type AppsBackings } from "./backings";

export interface SelfHostAppsRuntimeOptions {
  /** Data dir root; `<root>/artifacts`. */
  readonly dataDir: string;
  /** Default tenant for direct runtime calls; request paths pass tenant explicitly. */
  readonly tenant?: string;
  readonly store: AppsStore;
  /** Routes bound integration calls to real APIs (policy/audit). */
  readonly resolver: ClientResolver;
  /** In-memory backings for tests. */
  readonly inMemory?: boolean;
}

export interface SelfHostAppsRuntime {
  readonly runtime: AppsRuntime;
  readonly backings: AppsBackings;
  readonly close: () => Promise<void>;
}

export const makeSelfHostAppsRuntime = (
  options: SelfHostAppsRuntimeOptions,
): SelfHostAppsRuntime => {
  const inMem = options.inMemory === true;
  const artifactStore = makeGitArtifactStore({
    root: inMem ? options.dataDir : join(options.dataDir, "artifacts"),
  });
  const sandbox = makeQuickjsToolSandbox();
  const backings: AppsBackings = {
    artifactStore,
    sandbox,
    store: options.store,
    resolver: options.resolver,
    defaultTenant: options.tenant,
  };
  const runtime = makeAppsRuntimeFromBackings(backings, options.resolver);

  return {
    runtime,
    backings,
    close: async () => {},
  };
};
