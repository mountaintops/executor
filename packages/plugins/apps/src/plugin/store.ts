import { Effect } from "effect";

import {
  definePluginStorageCollection,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// AppsStore: descriptor pointer persistence and connection-to-scope mapping.
// ---------------------------------------------------------------------------

export const descriptorCollection = definePluginStorageCollection("published_descriptor", {
  Type: {} as {
    readonly tenant: string;
    readonly scope: string;
    readonly snapshotId: string;
    readonly descriptor: AppDescriptor;
    readonly publishedAt: number;
  },
});

export const scopeConnectionCollection = definePluginStorageCollection("apps_scope_connection", {
  Type: {} as {
    readonly tenant: string;
    readonly connectionName: string;
    readonly scope: string;
  },
});

export const githubSourceTokenCollection = definePluginStorageCollection(
  "apps_github_source_token",
  {
    Type: {} as {
      readonly tenant: string;
      readonly scope: string;
      readonly provider: string;
      readonly itemId: string;
      readonly updatedAt: number;
    },
  },
);

export interface AppDescriptorRecord {
  readonly descriptor: AppDescriptor;
  readonly publishedAt: number;
}

export interface GitHubSourceTokenRef {
  readonly provider: string;
  readonly itemId: string;
  readonly updatedAt: number;
}

export interface AppsStore {
  readonly putDescriptor: (
    tenant: string,
    owner: "org" | "user",
    descriptor: AppDescriptor,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getDescriptor: (
    tenant: string,
    scope: string,
  ) => Effect.Effect<AppDescriptor | null, StorageFailure>;
  readonly listDescriptors: (
    tenant: string,
  ) => Effect.Effect<readonly AppDescriptorRecord[], StorageFailure>;
  readonly putScopeForConnection: (
    tenant: string,
    connectionName: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getScopeForConnection: (
    tenant: string,
    connectionName: string,
  ) => Effect.Effect<string | null, StorageFailure>;
  readonly putGitHubSourceTokenRef: (
    tenant: string,
    scope: string,
    ref: GitHubSourceTokenRef,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getGitHubSourceTokenRef: (
    tenant: string,
    scope: string,
  ) => Effect.Effect<GitHubSourceTokenRef | null, StorageFailure>;
}

export interface AppsStoreDeps {
  readonly pluginStorage: PluginStorageFacade;
}

export const makeAppsStore = (deps: AppsStoreDeps): AppsStore => {
  const descriptors = deps.pluginStorage.collection(descriptorCollection);
  const scopeConnections = deps.pluginStorage.collection(scopeConnectionCollection);
  const githubSourceTokens = deps.pluginStorage.collection(githubSourceTokenCollection);
  // Tenant is now part of apps storage keys. The apps subsystem had not shipped
  // before this key shape, so no migration from the old scope-only keys is needed.
  const keyFor = (tenant: string, key: string): string => `${tenant}:${key}`;
  return {
    putScopeForConnection: (tenant, connectionName, scope) =>
      scopeConnections
        .put({
          owner: "org",
          key: keyFor(tenant, connectionName),
          data: { tenant, connectionName, scope },
        })
        .pipe(Effect.asVoid),
    getScopeForConnection: (tenant, connectionName) =>
      scopeConnections
        .get({ key: keyFor(tenant, connectionName) })
        .pipe(Effect.map((entry) => entry?.data.scope ?? null)),
    putGitHubSourceTokenRef: (tenant, scope, ref) =>
      githubSourceTokens
        .put({
          owner: "org",
          key: keyFor(tenant, scope),
          data: { tenant, scope, ...ref },
        })
        .pipe(Effect.asVoid),
    getGitHubSourceTokenRef: (tenant, scope) =>
      githubSourceTokens
        .get({ key: keyFor(tenant, scope) })
        .pipe(Effect.map((entry) => entry?.data ?? null)),
    putDescriptor: (tenant, owner, descriptor) =>
      descriptors
        .put({
          owner,
          key: keyFor(tenant, descriptor.scope),
          data: {
            tenant,
            scope: descriptor.scope,
            snapshotId: descriptor.snapshotId,
            descriptor,
            publishedAt: Date.now(),
          },
        })
        .pipe(Effect.asVoid),
    getDescriptor: (tenant, scope) =>
      descriptors
        .get({ key: keyFor(tenant, scope) })
        .pipe(Effect.map((entry) => entry?.data.descriptor ?? null)),
    listDescriptors: (tenant) =>
      descriptors.list({ keyPrefix: `${tenant}:` }).pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({
            descriptor: entry.data.descriptor,
            publishedAt: entry.data.publishedAt,
          })),
        ),
      ),
  };
};
