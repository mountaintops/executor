import { Effect } from "effect";

import {
  definePluginStorageCollection,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";

// ---------------------------------------------------------------------------
// AppsStore: descriptor pointer persistence.
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
  readonly removeDescriptor: (tenant: string, scope: string) => Effect.Effect<void, StorageFailure>;
  readonly listDescriptors: (
    tenant: string,
  ) => Effect.Effect<readonly AppDescriptorRecord[], StorageFailure>;
}

export interface AppsStoreDeps {
  readonly pluginStorage: PluginStorageFacade;
}

export const makeAppsStore = (deps: AppsStoreDeps): AppsStore => {
  const descriptors = deps.pluginStorage.collection(descriptorCollection);
  // Tenant is now part of apps storage keys. The apps subsystem had not shipped
  // before this key shape, so no migration from the old scope-only keys is needed.
  const keyFor = (tenant: string, key: string): string => `${tenant}:${key}`;
  return {
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
    removeDescriptor: (tenant, scope) =>
      descriptors.remove({ owner: "org", key: keyFor(tenant, scope) }),
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
