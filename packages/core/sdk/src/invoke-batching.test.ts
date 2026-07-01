import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { createExecutor, collectTables } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import { withQueryContext } from "@executor-js/fumadb/query";
import type { FumaDb } from "./fuma-runtime";

// ---------------------------------------------------------------------------
// Query-counting FumaDb wrapper. Counts reads per `${method}:${table}` while
// forwarding everything else, and re-wraps `withContext` results so the
// counter survives the executor's own context application.
// ---------------------------------------------------------------------------

type QueryCounts = Map<string, number>;

const COUNTED_METHODS = new Set(["findFirst", "findMany", "count"]);

const countingDb = (db: FumaDb, counts: QueryCounts): FumaDb => {
  // oxlint-disable-next-line executor/no-double-cast -- boundary: test spy walks the ORM object's own members reflectively
  const record = db as unknown as Record<string, unknown>;
  const wrapper: Record<string, unknown> = {};
  // Copy every member (methods included) off the real query object; a Proxy
  // can't stand in because FumaDb's properties are non-configurable (proxy
  // invariant violation on `get`). `withContext` and friends are
  // non-enumerable, so walk own property names, not Object.keys.
  for (const key of Object.getOwnPropertyNames(record)) {
    const value = record[key];
    if (typeof value !== "function") {
      wrapper[key] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => unknown;
    if (COUNTED_METHODS.has(key)) {
      wrapper[key] = (table: string, ...rest: unknown[]) => {
        const countKey = `${key}:${table}`;
        counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
        return fn.call(db, table, ...rest);
      };
    } else if (key === "withContext") {
      wrapper[key] = (context: unknown) =>
        countingDb((fn as (c: unknown) => FumaDb).call(db, context), counts);
    } else {
      wrapper[key] = (...args: unknown[]) => fn.call(db, ...args);
    }
  }
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the wrapper delegates every FumaDb member 1:1
  return wrapper as unknown as FumaDb;
};

const totalFor = (counts: QueryCounts, table: string): number => {
  let total = 0;
  for (const [key, count] of counts) {
    if (key.endsWith(`:${table}`)) total += count;
  }
  return total;
};

// ---------------------------------------------------------------------------
// Fixture: a plugin with one integration and two tools.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("demo");
const CONN = ConnectionName.make("main");

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
  };
};

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [
        { name: ToolName.make("alpha"), description: "alpha" },
        { name: ToolName.make("beta"), description: "beta" },
      ],
    }),
  invokeTool: ({ toolRow, args }) => Effect.succeed({ ran: toolRow.name, args }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Demo", config: {} }),
  }),
}))();

const addr = (tool: string): ToolAddress => ToolAddress.make(`tools.${INTEG}.org.${CONN}.${tool}`);

const TENANT = "test-tenant";
const SUBJECT = "test-subject";

const makeCountedExecutor = Effect.fnUntraced(function* () {
  const counts: QueryCounts = new Map();
  const tables = collectTables();
  const testDb = yield* Effect.promise(() =>
    createSqliteTestFumaDb({ tables, namespace: "executor_test" }),
  );
  const db = withQueryContext(countingDb(testDb.db, counts), {
    tenant: TENANT,
    subject: SUBJECT,
  });
  const executor = yield* createExecutor({
    tenant: Tenant.make(TENANT),
    subject: Subject.make(SUBJECT),
    db,
    plugins: [demoPlugin] as const,
    onElicitation: "accept-all",
  });
  yield* executor.demo.seed();
  yield* executor.connections.create({
    owner: "org",
    name: CONN,
    integration: INTEG,
    template: AuthTemplateSlug.make("apiKey"),
    from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("v") },
  });
  return { executor, counts };
});

describe("invoke-path batching", () => {
  it.effect("N concurrent executes share one query per table (no N+1)", () =>
    Effect.gen(function* () {
      const { executor, counts } = yield* makeCountedExecutor();

      counts.clear();
      const N = 25;
      const results = yield* Effect.all(
        Array.from({ length: N }, (_, i) =>
          executor.execute(addr(i % 2 === 0 ? "alpha" : "beta"), { i }),
        ),
        { concurrency: "unbounded" },
      );

      expect(results).toHaveLength(N);
      expect(results[0]).toEqual({ ran: "alpha", args: { i: 0 } });

      // The batch window collapses all N lookups into one query per table.
      // Allow a little slack (the runtime may split across two microtask
      // windows under load) but the point is O(1), not O(N).
      expect(totalFor(counts, "tool")).toBeLessThanOrEqual(2);
      expect(totalFor(counts, "connection")).toBeLessThanOrEqual(2);
      expect(totalFor(counts, "integration")).toBeLessThanOrEqual(2);
      expect(totalFor(counts, "tool_policy")).toBeLessThanOrEqual(2);
    }),
  );

  it.effect("sequential executes still behave (batch of one)", () =>
    Effect.gen(function* () {
      const { executor, counts } = yield* makeCountedExecutor();

      counts.clear();
      const first = yield* executor.execute(addr("alpha"), { seq: 1 });
      const second = yield* executor.execute(addr("beta"), { seq: 2 });

      expect(first).toEqual({ ran: "alpha", args: { seq: 1 } });
      expect(second).toEqual({ ran: "beta", args: { seq: 2 } });
      // Two sequential invokes = two windows: exactly the per-call point
      // queries the unbatched path made, no regression.
      expect(totalFor(counts, "tool")).toBe(2);
      expect(totalFor(counts, "connection")).toBe(2);
    }),
  );

  it.effect("a missing tool inside a batch fails alone, peers succeed", () =>
    Effect.gen(function* () {
      const { executor } = yield* makeCountedExecutor();

      const [ok, missing] = yield* Effect.all(
        [
          Effect.result(executor.execute(addr("alpha"), {})),
          Effect.result(executor.execute(addr("nope"), {})),
        ],
        { concurrency: "unbounded" },
      );

      expect(Result.isSuccess(ok)).toBe(true);
      expect(Result.isFailure(missing)).toBe(true);
      if (!Result.isFailure(missing)) return;
      expect(Predicate.isTagged(missing.failure, "ToolNotFoundError")).toBe(true);
    }),
  );
});
