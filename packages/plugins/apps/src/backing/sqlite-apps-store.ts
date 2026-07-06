import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect, Schema } from "effect";

import { StorageError, type StorageFailure } from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore, GitHubSourceTokenRef } from "../plugin/store";

// ---------------------------------------------------------------------------
// SQLite-backed AppsStore (self-hosted). One small SQLite file stores the
// published descriptor per scope and the exact connection-to-scope mapping.
// ---------------------------------------------------------------------------

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS descriptors (tenant TEXT NOT NULL, scope TEXT NOT NULL, snapshot_id TEXT NOT NULL, descriptor TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY (tenant, scope));
CREATE TABLE IF NOT EXISTS scope_connections (tenant TEXT NOT NULL, connection_name TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY (tenant, connection_name));
CREATE TABLE IF NOT EXISTS github_source_tokens (tenant TEXT NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL, item_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (tenant, scope));
`;

const storageFail = (message: string, cause: unknown): StorageFailure =>
  new StorageError({ message, cause });

const decodeDescriptorJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const decodeDescriptor = (
  value: unknown,
  message: string,
): Effect.Effect<AppDescriptor, StorageFailure> =>
  decodeDescriptorJson(String(value)).pipe(
    Effect.map((descriptor) => descriptor as AppDescriptor),
    Effect.mapError((cause) => storageFail(message, cause)),
  );

export interface SqliteAppsStoreOptions {
  readonly path: string;
}

export const makeSqliteAppsStore = (options: SqliteAppsStoreOptions): AppsStore => {
  if (options.path !== ":memory:") mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const client: Client = createClient({ url: toUrl(options.path) });
  let ready: Promise<void> | undefined;
  const init = async () => {
    if (!ready) {
      ready = (async () => {
        for (const stmt of SCHEMA.split(";")) {
          const s = stmt.trim();
          if (s) await client.execute(s);
        }
      })();
    }
    return ready;
  };

  return {
    putDescriptor: (tenant, _owner, descriptor) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: `INSERT INTO descriptors (tenant, scope, snapshot_id, descriptor, published_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(tenant, scope) DO UPDATE SET snapshot_id=excluded.snapshot_id, descriptor=excluded.descriptor, published_at=excluded.published_at`,
            args: [
              tenant,
              descriptor.scope,
              descriptor.snapshotId,
              JSON.stringify(descriptor),
              Date.now(),
            ],
          });
        },
        catch: (cause) => storageFail("putDescriptor failed", cause),
      }),
    getDescriptor: (tenant, scope) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT descriptor FROM descriptors WHERE tenant = ? AND scope = ?",
            args: [tenant, scope],
          });
          const row = res.rows[0];
          return row?.descriptor ?? null;
        },
        catch: (cause) => storageFail("getDescriptor failed", cause),
      }).pipe(
        Effect.flatMap((descriptor) =>
          descriptor === null
            ? Effect.succeed(null)
            : decodeDescriptor(descriptor, "getDescriptor failed"),
        ),
      ),
    listDescriptors: (tenant) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT descriptor, published_at FROM descriptors WHERE tenant = ? ORDER BY published_at DESC",
            args: [tenant],
          });
          return res.rows;
        },
        catch: (cause) => storageFail("listDescriptors failed", cause),
      }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeDescriptor(row.descriptor, "listDescriptors failed").pipe(
              Effect.map((descriptor) => ({
                descriptor,
                publishedAt: Number(row.published_at),
              })),
            ),
          ),
        ),
      ),
    putScopeForConnection: (tenant, connectionName, scope) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: "INSERT INTO scope_connections (tenant, connection_name, scope) VALUES (?, ?, ?) ON CONFLICT(tenant, connection_name) DO UPDATE SET scope=excluded.scope",
            args: [tenant, connectionName, scope],
          });
        },
        catch: (cause) => storageFail("putScopeForConnection failed", cause),
      }),
    getScopeForConnection: (tenant, connectionName) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          const res = await client.execute({
            sql: "SELECT scope FROM scope_connections WHERE tenant = ? AND connection_name = ?",
            args: [tenant, connectionName],
          });
          return res.rows[0] ? String(res.rows[0].scope) : null;
        },
        catch: (cause) => storageFail("getScopeForConnection failed", cause),
      }),
    putGitHubSourceTokenRef: (tenant, scope, ref) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: "INSERT INTO github_source_tokens (tenant, scope, provider, item_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant, scope) DO UPDATE SET provider=excluded.provider, item_id=excluded.item_id, updated_at=excluded.updated_at",
            args: [tenant, scope, ref.provider, ref.itemId, ref.updatedAt],
          });
        },
        catch: (cause) => storageFail("putGitHubSourceTokenRef failed", cause),
      }),
    getGitHubSourceTokenRef: (tenant, scope) =>
      Effect.tryPromise({
        try: async (): Promise<GitHubSourceTokenRef | null> => {
          await init();
          const res = await client.execute({
            sql: "SELECT provider, item_id, updated_at FROM github_source_tokens WHERE tenant = ? AND scope = ?",
            args: [tenant, scope],
          });
          const row = res.rows[0];
          if (!row) return null;
          return {
            provider: String(row.provider),
            itemId: String(row.item_id),
            updatedAt: Number(row.updated_at),
          };
        },
        catch: (cause) => storageFail("getGitHubSourceTokenRef failed", cause),
      }),
  };
};
