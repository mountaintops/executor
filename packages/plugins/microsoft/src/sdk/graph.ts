import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as YAML from "yaml";

import { AuthTemplateSlug } from "@executor-js/sdk/core";
import {
  AuthenticationSchema,
  OpenApiParseError,
  type Authentication,
  type OpenApiIntegrationConfig,
} from "@executor-js/plugin-openapi";

import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  MICROSOFT_TOKEN_URL,
  microsoftGraphExactPathsForPresetIds,
  microsoftGraphPathPrefixesForPresetIds,
  microsoftGraphScopesForPresetIds,
} from "./presets";

export interface MicrosoftGraphSelectionInput {
  readonly presetIds?: readonly string[];
  readonly customScopes?: readonly string[];
  readonly specUrl?: string;
}

export interface MicrosoftGraphSpecBuild {
  readonly specText: string;
  readonly specUrl: string;
  readonly presetIds: readonly string[];
  readonly customScopes: readonly string[];
  readonly scopes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly authenticationTemplate: readonly Authentication[];
}

export type MicrosoftGraphIntegrationConfig = OpenApiIntegrationConfig & {
  readonly microsoftGraphPresetIds?: readonly string[];
  readonly microsoftGraphCustomScopes?: readonly string[];
  readonly microsoftGraphScopes?: readonly string[];
  readonly microsoftGraphExactPaths?: readonly string[];
  readonly microsoftGraphPathPrefixes?: readonly string[];
};

const MicrosoftGraphIntegrationConfigSchema = Schema.Struct({
  specHash: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
  microsoftGraphPresetIds: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphCustomScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphScopes: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphExactPaths: Schema.optional(Schema.Array(Schema.String)),
  microsoftGraphPathPrefixes: Schema.optional(Schema.Array(Schema.String)),
});

const decodeMicrosoftConfig = Schema.decodeUnknownOption(MicrosoftGraphIntegrationConfigSchema);

export const decodeMicrosoftGraphIntegrationConfig = (
  value: unknown,
): MicrosoftGraphIntegrationConfig | null =>
  Option.getOrNull(decodeMicrosoftConfig(value)) as MicrosoftGraphIntegrationConfig | null;

const uniqueStrings = (values: Iterable<string>): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const normalizeSelection = (input: MicrosoftGraphSelectionInput) => {
  const presetIds = uniqueStrings(
    input.presetIds && input.presetIds.length > 0
      ? input.presetIds
      : MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  );
  const customScopes = uniqueStrings(input.customScopes ?? []);
  const scopes = microsoftGraphScopesForPresetIds(presetIds, customScopes);
  const exactPaths = microsoftGraphExactPathsForPresetIds(presetIds);
  const pathPrefixes = microsoftGraphPathPrefixesForPresetIds(presetIds);
  const specUrl = input.specUrl?.trim() || MICROSOFT_GRAPH_OPENAPI_URL;
  return { presetIds, customScopes, scopes, exactPaths, pathPrefixes, specUrl };
};

const microsoftOAuthTemplate = (scopes: readonly string[]): readonly Authentication[] => [
  {
    slug: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
    kind: "oauth2",
    authorizationUrl: MICROSOFT_AUTHORIZATION_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    scopes,
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const matchesGraphPath = (
  path: string,
  exactPaths: ReadonlySet<string>,
  pathPrefixes: readonly string[],
): boolean => {
  if (exactPaths.has(path)) return true;
  return pathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

export const fetchMicrosoftGraphOpenApiSpec = Effect.fn("Microsoft.fetchGraphOpenApiSpec")(
  function* (specUrl: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(specUrl).pipe(
          HttpClientRequest.setHeader("Accept", "application/yaml, text/yaml, */*"),
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new OpenApiParseError({
              message: "Failed to fetch Microsoft Graph OpenAPI document",
            }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new OpenApiParseError({
        message: `Failed to fetch Microsoft Graph OpenAPI document: HTTP ${response.status}`,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to read Microsoft Graph OpenAPI document body",
          }),
      ),
    );
  },
);

export const filterMicrosoftGraphOpenApiSpec = (
  specText: string,
  options: {
    readonly scopes: readonly string[];
    readonly exactPaths: readonly string[];
    readonly pathPrefixes: readonly string[];
  },
): Effect.Effect<string, OpenApiParseError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => YAML.parse(specText) as unknown,
      catch: () =>
        new OpenApiParseError({
          message: "Failed to parse Microsoft Graph OpenAPI document",
        }),
    });
    if (!isRecord(parsed)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document must be an object",
      });
    }
    const paths = parsed.paths;
    if (!isRecord(paths)) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph OpenAPI document is missing paths",
      });
    }

    const exactPaths = new Set(options.exactPaths);
    const filteredPaths = Object.fromEntries(
      Object.entries(paths).filter(([path]) =>
        matchesGraphPath(path, exactPaths, options.pathPrefixes),
      ),
    );
    if (Object.keys(filteredPaths).length === 0) {
      return yield* new OpenApiParseError({
        message: "Microsoft Graph scope selection did not match any OpenAPI paths",
      });
    }

    const components = isRecord(parsed.components) ? parsed.components : {};
    const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
    const next = {
      ...parsed,
      info: {
        ...(isRecord(parsed.info) ? parsed.info : {}),
        title: "Microsoft Graph",
        description: "Selected Microsoft Graph workloads from the v1.0 OpenAPI document.",
      },
      servers: [{ url: MICROSOFT_GRAPH_BASE_URL }],
      paths: filteredPaths,
      components: {
        ...components,
        securitySchemes: {
          ...securitySchemes,
          [MICROSOFT_AUTH_TEMPLATE_SLUG]: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: MICROSOFT_AUTHORIZATION_URL,
                tokenUrl: MICROSOFT_TOKEN_URL,
                scopes: Object.fromEntries(options.scopes.map((scope) => [scope, scope])),
              },
            },
          },
        },
      },
      security: [{ [MICROSOFT_AUTH_TEMPLATE_SLUG]: [...options.scopes] }],
    };

    return yield* Effect.try({
      try: () => YAML.stringify(next),
      catch: () =>
        new OpenApiParseError({
          message: "Failed to serialize Microsoft Graph OpenAPI document",
        }),
    });
  });

export const buildMicrosoftGraphOpenApiSpec = (
  input: MicrosoftGraphSelectionInput,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
): Effect.Effect<MicrosoftGraphSpecBuild, OpenApiParseError> =>
  Effect.gen(function* () {
    const selection = normalizeSelection(input);
    const sourceText = yield* fetchMicrosoftGraphOpenApiSpec(selection.specUrl).pipe(
      Effect.provide(httpClientLayer),
    );
    const specText = yield* filterMicrosoftGraphOpenApiSpec(sourceText, selection);
    return {
      ...selection,
      specText,
      authenticationTemplate: microsoftOAuthTemplate(selection.scopes),
    };
  });
