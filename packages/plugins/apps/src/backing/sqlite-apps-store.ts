import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect, Schema } from "effect";

import { StorageError, type StorageFailure } from "@executor-js/sdk";

import type { AppDescriptor } from "../pipeline/descriptor";
import type { AppsStore } from "../plugin/store";

// ---------------------------------------------------------------------------
// SQLite-backed AppsStore (self-hosted). One small SQLite file stores the
// published descriptor per source scope.
// ---------------------------------------------------------------------------

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS descriptors (tenant TEXT NOT NULL, scope TEXT NOT NULL, snapshot_id TEXT NOT NULL, descriptor TEXT NOT NULL, published_at INTEGER NOT NULL, PRIMARY KEY (tenant, scope));
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
    removeDescriptor: (tenant, scope) =>
      Effect.tryPromise({
        try: async () => {
          await init();
          await client.execute({
            sql: "DELETE FROM descriptors WHERE tenant = ? AND scope = ?",
            args: [tenant, scope],
          });
        },
        catch: (cause) => storageFail("removeDescriptor failed", cause),
      }),
  };
};
