// Reproduction for executor#1146:
// "GraphQL plugin generates invalid operations against large schemas
//  (missing required nested args, composite fields without selections)".
//
// This drives the real product flow end-to-end against GitLab's REAL GraphQL
// schema, served by the GitLab emulator from @executor-js/emulate. The emulator
// loads GitLab's full published SDL (4000+ types) and stands it up with real
// graphql-js introspection and validation, so the plugin introspects the
// genuine GitLab type system, freezes one machine-built selection set per root
// field at connect time, and sends that operation string on every call.
//
// `createEmulator({ service: "gitlab" })` boots that server in-process here; the
// same service is hosted at https://gitlab.emulators.dev with zero setup. The
// emulator has no business-logic resolvers wired: against a schema this rich the
// generated operations are not valid GraphQL (the builder caps depth at 2, bails
// to "" on cycles, and never threads nested field arguments), so the server
// rejects them on VALIDATION before any field would resolve, and the synced tool
// fails on every call.
//
// `buildSelectionSet` (packages/plugins/graphql/src/sdk/plugin.ts) is the
// source: `if (depth > 2) return ""` and the `seen` cycle guard both make a
// nested selection empty, after which the parent still prints the composite
// field name bare (invalid for an object/connection type); nested required
// arguments are never emitted at all.
//
// The assertions encode the BUG as it stands today. When the selection-set
// builder is fixed (bound depth without emitting bare composites; thread nested
// required args, or omit fields it cannot satisfy) these calls should return
// ok:true, and these expectations should be flipped to assert success.

import { createServer } from "node:net";

import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  buildClientSchema,
  getIntrospectionQuery,
  isNonNullType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  type ToolError,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { createEmulator, type Emulator } from "@executor-js/emulate";

import { graphqlPlugin } from "./plugin";

// A free localhost port, so parallel test files never collide on a fixed one.
const availablePort = Effect.callback<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resume(Effect.succeed(port)));
  });
});

// The GitLab emulator, spawned in-process and torn down with the test scope.
// It serves GitLab's full real GraphQL schema at /api/graphql; the operations
// the plugin generates fail validation before any field would resolve.
const gitlabEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    return yield* Effect.promise(() => createEmulator({ service: "gitlab", port }));
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

const graphqlEndpoint = (emulator: Emulator): string => `${emulator.url}/api/graphql`;

// Introspect the live emulator endpoint into an executable client schema, the
// same type system the plugin sees, so the sweep below can enumerate root query
// fields that take no required argument.
const introspectGitlabSchema = (endpoint: string): Effect.Effect<GraphQLSchema> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({ query: getIntrospectionQuery() }),
      ),
    );
    const body = (yield* response.json) as {
      readonly data?: IntrospectionQuery;
      readonly errors?: unknown;
    };
    if (!body.data) {
      return yield* Effect.die(
        `gitlab emulator introspection failed: ${JSON.stringify(body.errors ?? body)}`,
      );
    }
    return buildClientSchema(body.data);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

// The two ways the generator produces an invalid operation, as graphql-js
// phrases them on the wire.
const COMPOSITE_WITHOUT_SELECTION = /must have a selection of subfields/;
const MISSING_REQUIRED_ARGUMENT =
  /argument "[^"]+" of type "[^"]+" is required, but it was not provided\./;
const isInvalidOperationMessage = (message: string): boolean =>
  COMPOSITE_WITHOUT_SELECTION.test(message) || MISSING_REQUIRED_ARGUMENT.test(message);

interface GraphqlErrorEntry {
  readonly message?: string;
}
interface GraphqlErrorDetails {
  readonly errors?: ReadonlyArray<GraphqlErrorEntry>;
}

// The upstream GraphQL errors ride in ToolError.details (typed Unknown at the
// core boundary). Narrow to the GraphQL error shape to read their messages.
const graphqlErrorMessages = (toolError: ToolError): readonly string[] => {
  const details = toolError.details as GraphqlErrorDetails | undefined;
  return (details?.errors ?? []).map((entry) => entry.message ?? "");
};

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
  );

const toolAddr = (integration: string, connection: string, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${connection}.${tool}`);

const createOrgConnection = (
  executor: Awaited<ReturnType<typeof makeExecutor>> extends Effect.Effect<infer A> ? A : never,
  input: { readonly integration: string; readonly name: string },
) =>
  executor.connections.create({
    owner: "org",
    name: ConnectionName.make(input.name),
    integration: IntegrationSlug.make(input.integration),
    template: AuthTemplateSlug.make("none"),
    value: "unused",
  });

// Root query fields that take no required argument: the plugin can call these
// with `{}`, so any failure is the generated SELECTION's fault, not a missing
// top-level input.
const noRequiredArgQueryFields = (schema: GraphQLSchema): readonly string[] => {
  const fields = schema.getQueryType()?.getFields() ?? {};
  return Object.keys(fields).filter((name) =>
    (fields[name]?.args ?? []).every((arg) => !isNonNullType(arg.type)),
  );
};

describe("graphqlPlugin invalid operations against GitLab's real schema (issue #1146)", () => {
  // Headline: one real root field, both failure mechanisms from the issue in a
  // single generated operation.
  it.effect(
    "query.currentUser: generated operation is rejected for bare composites and a dropped required arg",
    () =>
      Effect.gen(function* () {
        const emulator = yield* gitlabEmulator;
        const executor = yield* makeExecutor();

        yield* executor.graphql.addIntegration({
          endpoint: graphqlEndpoint(emulator),
          slug: "gitlab",
        });
        yield* createOrgConnection(executor, { integration: "gitlab", name: "main" });

        // Introspection synced currentUser as a tool.
        const tools = yield* executor.tools.list();
        expect(
          tools.map((tool) => String(tool.name)),
          "introspection produced a query.currentUser tool",
        ).toContain("query.currentUser");

        const result = yield* executor.execute(toolAddr("gitlab", "main", "query.currentUser"), {});

        // BUG: a plain call fails. The upstream rejects the frozen operation.
        expect(result, "the generated operation is rejected by the server").toMatchObject({
          ok: false,
          error: { code: "graphql_errors" },
        });
        if (result.ok) return; // narrow for the type-checker; the assertion above already failed otherwise.

        const messages = graphqlErrorMessages(result.error);

        // Mechanism 1 (depth>2 cutoff + cycle guard): composite fields are
        // emitted with no sub-selection, e.g. the `node` of a connection edge.
        expect(messages, "a composite field is emitted with no sub-selection").toEqual(
          expect.arrayContaining([expect.stringMatching(COMPOSITE_WITHOUT_SELECTION)]),
        );

        // Mechanism 2 (nested args never threaded): a selected field that
        // requires an argument is emitted without it.
        expect(messages, "a selected field's required argument is dropped").toEqual(
          expect.arrayContaining([expect.stringMatching(MISSING_REQUIRED_ARGUMENT)]),
        );
      }),
    60000,
  );

  // Systemic: the failure is not one unlucky field. Sweep every generated
  // query.* tool that takes no required top-level argument and count how many
  // produce an operation the server rejects as invalid.
  it.effect(
    "the generator emits invalid operations across many of the schema's root query fields",
    () =>
      Effect.gen(function* () {
        const emulator = yield* gitlabEmulator;
        const executor = yield* makeExecutor();

        yield* executor.graphql.addIntegration({
          endpoint: graphqlEndpoint(emulator),
          slug: "gitlab",
        });
        yield* createOrgConnection(executor, { integration: "gitlab", name: "main" });

        const gitlabSchema = yield* introspectGitlabSchema(graphqlEndpoint(emulator));

        const tools = yield* executor.tools.list();
        const generatedQueryTools = new Set(
          tools.map((tool) => String(tool.name)).filter((name) => name.startsWith("query.")),
        );
        const candidates = noRequiredArgQueryFields(gitlabSchema).filter((field) =>
          generatedQueryTools.has(`query.${field}`),
        );
        expect(
          candidates.length,
          "the real schema yields many no-required-arg query tools to exercise",
        ).toBeGreaterThan(20);

        const invalidOperationFields: string[] = [];
        for (const field of candidates) {
          const result = yield* executor.execute(toolAddr("gitlab", "main", `query.${field}`), {});
          if (result.ok) continue;
          if (graphqlErrorMessages(result.error).some(isInvalidOperationMessage)) {
            invalidOperationFields.push(field);
          }
        }

        // BUG: a large fraction of the generated query tools are dead on
        // arrival. currentUser is one of them; it is not a lone outlier.
        expect(
          invalidOperationFields.length,
          "many generated query tools emit operations the server rejects as invalid",
        ).toBeGreaterThan(10);
        expect(
          invalidOperationFields,
          "currentUser is among the invalid generated tools",
        ).toContain("currentUser");
      }),
    60000,
  );
});
