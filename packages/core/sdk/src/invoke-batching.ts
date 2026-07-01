// ---------------------------------------------------------------------------
// Invoke-path batching: DataLoader semantics via Effect Request/RequestResolver.
//
// The invoke hot path loads four things per call: the tool row, the active
// policy rule set, the connection row, and the integration row. Called once,
// that's four point queries, which is fine. Called N times concurrently (code
// mode fanning out `await Promise.all(items.map(x => tools.foo.bar(x)))`, an
// MCP host serving parallel tool calls), it's 4×N queries against the same
// handful of rows: the classic N+1.
//
// Each lookup below is an Effect `Request` plus a `RequestResolver`. The
// Effect runtime collects every request issued within the same microtask
// window (resolver delay is `Effect.yieldNow`) and hands the resolver the
// whole batch, which it serves with ONE query per table. Sequential callers
// pay nothing: a batch of one is exactly the point query this replaced. There
// is no cross-batch caching; every batch re-reads storage, so invalidation
// semantics are unchanged.
//
// Requests are keyed by plain data (owner/slug/name strings), never rows, so
// equality is meaningful and nothing heavy is retained.
// ---------------------------------------------------------------------------

import { Effect, Exit, Request, RequestResolver } from "effect";

import type { ConnectionRow, IntegrationRow, ToolInvocationRow } from "./core-schema";
import { activeFumaDbRef, type StorageFailure } from "./fuma-runtime";
import type { ConnectionName, IntegrationSlug, Owner, ToolName } from "./ids";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

interface GetToolRow extends Request.Request<ToolInvocationRow | null, StorageFailure> {
  readonly _tag: "GetToolRow";
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly connection: ConnectionName;
  readonly tool: ToolName;
}
const GetToolRow = Request.tagged<GetToolRow>("GetToolRow");

interface GetConnectionRow extends Request.Request<ConnectionRow | null, StorageFailure> {
  readonly _tag: "GetConnectionRow";
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
}
const GetConnectionRow = Request.tagged<GetConnectionRow>("GetConnectionRow");

interface GetIntegrationRow extends Request.Request<IntegrationRow | null, StorageFailure> {
  readonly _tag: "GetIntegrationRow";
  readonly slug: IntegrationSlug;
}
const GetIntegrationRow = Request.tagged<GetIntegrationRow>("GetIntegrationRow");

// The policy rule set is one shared snapshot per batch window: every request
// is identical, so the resolver runs the underlying load once and fans the
// result out to all awaiting fibers.
interface GetPolicyRuleSet<A> extends Request.Request<A, StorageFailure> {
  readonly _tag: "GetPolicyRuleSet";
}

// ---------------------------------------------------------------------------
// Wiring: the executor passes its storage closures in; we hand back
// point-lookup functions with identical signatures to the ones they replace.
// ---------------------------------------------------------------------------

export interface InvokeBatchingDeps<TPolicyRuleSet> {
  /** Batched tool-row load: one query for all (owner, integration, connection,
   *  tool) tuples in the window, projected to the invocation columns. */
  readonly loadToolRows: (
    requests: readonly {
      readonly owner: Owner;
      readonly integration: IntegrationSlug;
      readonly connection: ConnectionName;
      readonly tool: ToolName;
    }[],
  ) => Effect.Effect<readonly ToolInvocationRow[], StorageFailure>;
  readonly loadConnectionRows: (
    requests: readonly {
      readonly owner: Owner;
      readonly integration: IntegrationSlug;
      readonly name: ConnectionName;
    }[],
  ) => Effect.Effect<readonly ConnectionRow[], StorageFailure>;
  readonly loadIntegrationRows: (
    slugs: readonly IntegrationSlug[],
  ) => Effect.Effect<readonly IntegrationRow[], StorageFailure>;
  readonly loadPolicyRuleSet: () => Effect.Effect<TPolicyRuleSet, StorageFailure>;
}

export interface InvokeBatching<TPolicyRuleSet> {
  readonly getToolRow: (input: {
    readonly owner: Owner;
    readonly integration: IntegrationSlug;
    readonly connection: ConnectionName;
    readonly tool: ToolName;
  }) => Effect.Effect<ToolInvocationRow | null, StorageFailure>;
  readonly getConnectionRow: (input: {
    readonly owner: Owner;
    readonly integration: IntegrationSlug;
    readonly name: ConnectionName;
  }) => Effect.Effect<ConnectionRow | null, StorageFailure>;
  readonly getIntegrationRow: (
    slug: IntegrationSlug,
  ) => Effect.Effect<IntegrationRow | null, StorageFailure>;
  readonly getPolicyRuleSet: () => Effect.Effect<TPolicyRuleSet, StorageFailure>;
}

// Batches from different fibers execute the `runAll` effect on a fiber forked
// with the FIRST caller's context. Inside `fuma.transaction` the storage
// handle rides on `activeFumaDbRef` in fiber context, so joining a shared
// batch would read through the wrong (or no) transaction. Transactional
// callers bypass the batch window and run the load directly on their own
// fiber — same query, exact transaction semantics, no cross-fiber sharing.
const inTransaction: Effect.Effect<boolean> = Effect.map(
  Effect.service(activeFumaDbRef),
  (active) => active !== null,
);

/** Complete every entry in a batch from a keyed index of loaded rows. A
 *  request whose key has no row completes with `null`: absence is a value
 *  (the invoke path turns it into its own typed not-found error). A load
 *  failure fails every entry in the batch, mirroring what each point query
 *  would have done. */
const completeFromIndex = <A extends Request.Request<unknown, StorageFailure>>(
  entries: readonly Request.Entry<A>[],
  load: Effect.Effect<ReadonlyMap<string, Request.Success<A>>, StorageFailure>,
  keyOf: (request: A) => string,
): Effect.Effect<void, StorageFailure> =>
  load.pipe(
    Effect.matchEffect({
      onSuccess: (index) =>
        Effect.sync(() => {
          for (const entry of entries) {
            entry.completeUnsafe(
              Exit.succeed((index.get(keyOf(entry.request)) ?? null) as Request.Success<A>),
            );
          }
        }),
      onFailure: (error) =>
        Effect.sync(() => {
          for (const entry of entries) {
            // The constraint pins A's error channel to StorageFailure, but the
            // conditional `Request.Error<A>` doesn't reduce over an unresolved
            // generic — assert the equivalence once here.
            entry.completeUnsafe(Exit.fail(error) as Exit.Exit<never, Request.Error<A>>);
          }
        }),
    }),
  );

/** The runtime collects entries per window without deduping equal requests;
 *  two fibers asking for the same connection contribute two entries. Loaders
 *  receive each distinct key once (DataLoader's contract) and both entries
 *  complete from the shared index. */
const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): readonly T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
};

const toolKey = (r: {
  readonly owner: string;
  readonly integration: string;
  readonly connection: string;
  readonly tool: string;
}): string => `${r.owner} ${r.integration} ${r.connection} ${r.tool}`;

const connectionKey = (r: {
  readonly owner: string;
  readonly integration: string;
  readonly name: string;
}): string => `${r.owner} ${r.integration} ${r.name}`;

export const makeInvokeBatching = <TPolicyRuleSet>(
  deps: InvokeBatchingDeps<TPolicyRuleSet>,
): InvokeBatching<TPolicyRuleSet> => {
  const toolResolver = RequestResolver.make<GetToolRow>((entries) =>
    completeFromIndex(
      entries,
      deps
        .loadToolRows(
          uniqueBy(
            entries.map((entry) => entry.request),
            toolKey,
          ),
        )
        .pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.map((row) => [
                  toolKey({
                    owner: row.owner,
                    integration: row.integration,
                    connection: row.connection,
                    tool: row.name,
                  }),
                  row,
                ]),
              ),
          ),
        ),
      toolKey,
    ),
  );

  const connectionResolver = RequestResolver.make<GetConnectionRow>((entries) =>
    completeFromIndex(
      entries,
      deps
        .loadConnectionRows(
          uniqueBy(
            entries.map((entry) => entry.request),
            connectionKey,
          ),
        )
        .pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.map((row) => [
                  connectionKey({
                    owner: row.owner,
                    integration: row.integration,
                    name: row.name,
                  }),
                  row,
                ]),
              ),
          ),
        ),
      connectionKey,
    ),
  );

  const integrationResolver = RequestResolver.make<GetIntegrationRow>((entries) =>
    completeFromIndex(
      entries,
      deps
        .loadIntegrationRows(
          uniqueBy(
            entries.map((entry) => entry.request.slug),
            String,
          ),
        )
        .pipe(Effect.map((rows) => new Map(rows.map((row) => [String(row.slug), row])))),
      (request) => String(request.slug),
    ),
  );

  const policyResolver = RequestResolver.make<GetPolicyRuleSet<TPolicyRuleSet>>((entries) =>
    deps.loadPolicyRuleSet().pipe(
      Effect.matchEffect({
        onSuccess: (ruleSet) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.succeed(ruleSet));
          }),
        onFailure: (error) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.fail(error));
          }),
      }),
    ),
  );
  const policyRequest = Request.of<GetPolicyRuleSet<TPolicyRuleSet>>()({
    _tag: "GetPolicyRuleSet",
  });

  const first = <A>(rows: readonly A[]): A | null => rows[0] ?? null;

  return {
    getToolRow: (input) =>
      Effect.flatMap(inTransaction, (transactional) =>
        transactional
          ? Effect.map(deps.loadToolRows([input]), first)
          : Effect.request(GetToolRow(input), toolResolver),
      ),
    getConnectionRow: (input) =>
      Effect.flatMap(inTransaction, (transactional) =>
        transactional
          ? Effect.map(deps.loadConnectionRows([input]), first)
          : Effect.request(GetConnectionRow(input), connectionResolver),
      ),
    getIntegrationRow: (slug) =>
      Effect.flatMap(inTransaction, (transactional) =>
        transactional
          ? Effect.map(deps.loadIntegrationRows([slug]), first)
          : Effect.request(GetIntegrationRow({ slug }), integrationResolver),
      ),
    getPolicyRuleSet: () =>
      Effect.flatMap(inTransaction, (transactional) =>
        transactional ? deps.loadPolicyRuleSet() : Effect.request(policyRequest, policyResolver),
      ),
  };
};
