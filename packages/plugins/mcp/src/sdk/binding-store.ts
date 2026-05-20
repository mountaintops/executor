import { Effect, Option, Predicate, Schema } from "effect";

import {
  type FumaTables,
  type PluginStorageEntry,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { AnnotationPolicy, McpStoredSourceData, McpToolBinding } from "./types";

export const mcpSchema = {} satisfies FumaTables;
export type McpSchema = typeof mcpSchema;

const SOURCE_COLLECTION = "source";
const BINDING_COLLECTION = "binding";

const decodeSourceData = Schema.decodeUnknownSync(McpStoredSourceData);
const encodeSourceData = Schema.encodeSync(McpStoredSourceData);
const decodeAnnotationPolicy = Schema.decodeUnknownSync(AnnotationPolicy);
const decodeBinding = Schema.decodeUnknownSync(McpToolBinding);
const encodeBinding = Schema.encodeSync(McpToolBinding);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return Option.getOrElse(decodeJson(value), () => value);
};

export interface McpStoredSource {
  readonly namespace: string;
  readonly scope: string;
  readonly name: string;
  readonly config: McpStoredSourceData;
  readonly annotationPolicy?: AnnotationPolicy;
}

export interface McpBindingStore {
  readonly listBindingsBySource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly toolId: string;
      readonly binding: McpToolBinding;
    }>,
    StorageFailure
  >;
  readonly getBinding: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<
    { readonly binding: McpToolBinding; readonly namespace: string } | null,
    StorageFailure
  >;
  readonly putBindings: (
    namespace: string,
    scope: string,
    entries: ReadonlyArray<{
      readonly toolId: string;
      readonly binding: McpToolBinding;
    }>,
  ) => Effect.Effect<void, StorageFailure>;
  readonly removeBindingsByNamespace: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSource | null, StorageFailure>;
  readonly getSourceConfig: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSourceData | null, StorageFailure>;
  readonly putSource: (source: McpStoredSource) => Effect.Effect<void, StorageFailure>;
  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: { readonly name?: string; readonly annotationPolicy?: AnnotationPolicy | null },
  ) => Effect.Effect<void, StorageFailure>;
  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
}

const sourceData = (source: McpStoredSource) => ({
  namespace: source.namespace,
  scope: source.scope,
  name: source.name,
  config: encodeSourceData(source.config),
  ...(source.annotationPolicy ? { annotationPolicy: source.annotationPolicy } : {}),
});

const bindingData = (
  namespace: string,
  entry: {
    readonly toolId: string;
    readonly binding: McpToolBinding;
  },
) => ({
  namespace,
  toolId: entry.toolId,
  binding: encodeBinding(entry.binding),
});

const rowToSource = (row: PluginStorageEntry): McpStoredSource | null => {
  const raw = coerceJson(row.data);
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.namespace !== "string" ||
    typeof record.scope !== "string" ||
    typeof record.name !== "string"
  ) {
    return null;
  }
  return {
    namespace: record.namespace,
    scope: record.scope,
    name: record.name,
    config: decodeSourceData(coerceJson(record.config)),
    annotationPolicy:
      record.annotationPolicy === undefined
        ? undefined
        : decodeAnnotationPolicy(coerceJson(record.annotationPolicy)),
  };
};

const rowToBinding = (
  row: PluginStorageEntry,
): {
  readonly toolId: string;
  readonly namespace: string;
  readonly binding: McpToolBinding;
} | null => {
  const raw = coerceJson(row.data);
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.toolId !== "string" || typeof record.namespace !== "string") return null;
  return {
    toolId: record.toolId,
    namespace: record.namespace,
    binding: decodeBinding(coerceJson(record.binding)),
  };
};

export const makeMcpStore = ({ pluginStorage }: StorageDeps<McpSchema>): McpBindingStore => {
  const listBindingRowsForSourceScope = (namespace: string, scope: string) =>
    pluginStorage
      .list({
        collection: BINDING_COLLECTION,
        keyPrefix: `${namespace}.`,
      })
      .pipe(
        Effect.map((rows) =>
          rows.filter((row) => {
            if (String(row.scopeId) !== scope) return false;
            return rowToBinding(row)?.namespace === namespace;
          }),
        ),
      );

  const removeBindingsForSourceScope = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      const rows = yield* listBindingRowsForSourceScope(namespace, scope);
      for (const row of rows) {
        yield* pluginStorage.remove({
          scope,
          collection: BINDING_COLLECTION,
          key: row.key,
        });
      }
    });

  return {
    listBindingsBySource: (namespace, scope) =>
      listBindingRowsForSourceScope(namespace, scope).pipe(
        Effect.map((rows) =>
          rows
            .map(rowToBinding)
            .filter(Predicate.isNotNull)
            .map((row) => ({ toolId: row.toolId, binding: row.binding })),
        ),
      ),

    getBinding: (toolId, scope) =>
      pluginStorage.getAtScope({ scope, collection: BINDING_COLLECTION, key: toolId }).pipe(
        Effect.map((row) => {
          const binding = row ? rowToBinding(row) : null;
          return binding ? { binding: binding.binding, namespace: binding.namespace } : null;
        }),
      ),

    putBindings: (namespace, scope, entries) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          yield* pluginStorage.put({
            scope,
            collection: BINDING_COLLECTION,
            key: entry.toolId,
            data: bindingData(namespace, entry),
          });
        }
      }),

    removeBindingsByNamespace: (namespace, scope) => removeBindingsForSourceScope(namespace, scope),

    getSource: (namespace, scope) =>
      pluginStorage
        .getAtScope({ scope, collection: SOURCE_COLLECTION, key: namespace })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    getSourceConfig: (namespace, scope) =>
      pluginStorage.getAtScope({ scope, collection: SOURCE_COLLECTION, key: namespace }).pipe(
        Effect.map((row) => {
          const source = row ? rowToSource(row) : null;
          return source?.config ?? null;
        }),
      ),

    putSource: (source) =>
      pluginStorage
        .put({
          scope: source.scope,
          collection: SOURCE_COLLECTION,
          key: source.namespace,
          data: sourceData(source),
        })
        .pipe(Effect.asVoid),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existing = yield* pluginStorage.getAtScope({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
        });
        const source = existing ? rowToSource(existing) : null;
        if (!source) return;
        yield* pluginStorage.put({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
          data: sourceData({
            ...source,
            name: patch.name ?? source.name,
            annotationPolicy:
              patch.annotationPolicy !== undefined
                ? (patch.annotationPolicy ?? undefined)
                : source.annotationPolicy,
          }),
        });
      }),

    removeSource: (namespace, scope) =>
      Effect.gen(function* () {
        yield* removeBindingsForSourceScope(namespace, scope);
        yield* pluginStorage.remove({
          scope,
          collection: SOURCE_COLLECTION,
          key: namespace,
        });
      }),
  };
};
