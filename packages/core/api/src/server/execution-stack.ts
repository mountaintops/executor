// ---------------------------------------------------------------------------
// Shared execution stack — turn a (user, org) into a runnable executor + engine.
//
// Cloud and self-host both had an identical `makeExecutionStack`:
//   createScopedExecutor -> createExecutionEngine({ executor, codeExecutor }) ->
//   { executor, engine }
// differing only in (a) the code substrate (cloud's Cloudflare dynamic-worker vs
// self-host's in-process QuickJS) and (b) cloud's usage-metering decorator
// (an app-only billing overlay), absent on self-host.
//
// This factory owns the common body. The two differences are injected:
//   - `CodeExecutorProvider` — the `codeExecutor` value. Cloud's Layer wraps
//     `makeDynamicWorkerExecutor({ loader: env.LOADER })`; self-host's wraps
//     `makeQuickJsExecutor()`.
//   - `EngineDecorator` — `decorate(engine) => engine`. Cloud's app layer applies
//     a usage-metering overlay; the default Layer is a no-op (self-host, local,
//     tests, and cloud's non-metering MCP session path).
//
// The per-(user, org) executor itself comes from `makeScopedExecutor` (sdk),
// which reads the DB handle / plugins / host config from its own seams. This
// lives in `@executor-js/api` because it is the only package that depends on
// both `@executor-js/sdk` (for `makeScopedExecutor`) and `@executor-js/execution`
// (for `createExecutionEngine`).
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";
import type * as Cause from "effect/Cause";

import {
  applyToolkitScope,
  EMPTY_TOOLKIT_SCOPE,
  type AnyPlugin,
  type Executor,
  type StorageFailure,
  type ToolkitResolver,
} from "@executor-js/sdk";
import {
  createExecutionEngine,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor-js/execution";

import { DbProvider } from "./executor-fuma-db";
import { HostConfig, PluginsProvider, makeScopedExecutor } from "./scoped-executor";

// ---------------------------------------------------------------------------
// CodeExecutorProvider seam — the host's code-execution substrate. Typed to the
// widened `Cause.YieldableError` channel (matching `ExecutionEngineService`) so
// a runtime-specific tagged error (DynamicWorkerExecutionError, QuickJS errors)
// assigns structurally.
// ---------------------------------------------------------------------------

export type CodeExecutor = ExecutionEngineConfig<Cause.YieldableError>["codeExecutor"];

export class CodeExecutorProvider extends Context.Service<CodeExecutorProvider, CodeExecutor>()(
  "@executor-js/api/CodeExecutorProvider",
) {}

// ---------------------------------------------------------------------------
// EngineDecorator seam — wrap the freshly built engine (e.g. with usage
// metering). `decorate` receives the same `(accountId, organizationId,
// organizationName)` identity the stack was built for, so a host can bind the
// decorator to the org (cloud's per-org usage metering needs the org id). The
// default Layer is a no-op so hosts that do not decorate (self-host, local,
// tests) get an identity transform for free.
// ---------------------------------------------------------------------------

export interface EngineStackIdentity {
  readonly accountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface EngineDecoratorShape {
  readonly decorate: <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ) => ExecutionEngine<E>;
}

export class EngineDecorator extends Context.Service<EngineDecorator, EngineDecoratorShape>()(
  "@executor-js/api/EngineDecorator",
) {}

/** No-op decorator: the engine passes through unchanged. */
export const EngineDecoratorNoop: Layer.Layer<EngineDecorator> = Layer.succeed(EngineDecorator)({
  decorate: (engine) => engine,
});

// ---------------------------------------------------------------------------
// makeExecutionStack — shared (user, org) -> { executor, engine }.
//
// Reads `makeScopedExecutor` (sdk), the code substrate from
// `CodeExecutorProvider`, and the engine wrap from `EngineDecorator`. The
// returned engine error channel is widened to `Cause.YieldableError`, matching
// `ExecutionEngineService` and the runtime-specific code executors.
// ---------------------------------------------------------------------------

export const makeExecutionStack = <
  const TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
>(
  accountId: string,
  organizationId: string,
  organizationName: string,
  /** Optional toolkit selector (slug or id). When set, the executor is narrowed
   *  to that toolkit's slice before the engine is built — so listing, search,
   *  description, core-tools, AND execute all see only the slice. Resolves via
   *  the `toolkits` plugin extension; an unknown/unauthorized selector applies
   *  an EMPTY slice (fail-closed — never the full account). */
  toolkitId?: string,
): Effect.Effect<
  { readonly executor: Executor<TPlugins>; readonly engine: ExecutionEngine<Cause.YieldableError> },
  StorageFailure,
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Effect.gen(function* () {
    const base = yield* makeScopedExecutor<TPlugins>(accountId, organizationId, organizationName);
    const executor = toolkitId ? yield* narrowToToolkit(base, toolkitId) : base;
    const codeExecutor = yield* CodeExecutorProvider;
    const { decorate } = yield* EngineDecorator;
    const engine = decorate(createExecutionEngine({ executor, codeExecutor }), {
      accountId,
      organizationId,
      organizationName,
    });
    return { executor, engine };
  });

// Resolve the toolkit slice via the `toolkits` plugin extension (stamped on the
// executor) and wrap the executor. Fail-closed: no extension or no match -> an
// empty slice, so a bad/cross-tenant selector exposes only static tools, never
// the full account.
const narrowToToolkit = <TPlugins extends readonly AnyPlugin[]>(
  base: Executor<TPlugins>,
  toolkitId: string,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const resolver = (base as { toolkits?: ToolkitResolver }).toolkits;
    const scope = resolver?.resolveScope ? yield* resolver.resolveScope(toolkitId) : null;
    return yield* applyToolkitScope(base, scope ?? EMPTY_TOOLKIT_SCOPE);
  });
