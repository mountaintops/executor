import { join } from "node:path";

import {
  makeGitArtifactStore,
  makeQuickjsToolSandbox,
  makeSqliteAppsStore,
  type AppsBackings,
} from "@executor-js/plugin-apps/api";

import { resolveDataDir } from "./config";

interface SelfHostAppsBackings {
  readonly backings: AppsBackings;
  readonly close: () => Promise<void>;
}

const createBackings = (dataDir: string): SelfHostAppsBackings => {
  const appsDir = join(dataDir, "apps");
  return {
    backings: {
      artifactStore: makeGitArtifactStore({ root: join(appsDir, "artifacts") }),
      sandbox: makeQuickjsToolSandbox(),
      store: makeSqliteAppsStore({ path: join(appsDir, "store.sqlite") }),
    },
    close: async () => {},
  };
};

let current: { readonly dataDir: string; readonly value: SelfHostAppsBackings } | undefined;

export const getSelfHostAppsBackings = (): AppsBackings => {
  const dataDir = resolveDataDir();
  if (current && current.dataDir === dataDir) return current.value.backings;
  const value = createBackings(dataDir);
  current = { dataDir, value };
  return value.backings;
};

export const closeSelfHostAppsBackings = async (): Promise<void> => {
  const value = current?.value;
  current = undefined;
  await value?.close();
};
