import { Effect } from "effect";
import type { SpecFormatAdapter } from "@executor-js/plugin-openapi";

import { buildMicrosoftGraphOpenApiSpec, microsoftGraphKeepPathItem } from "./graph";

export const microsoftGraphAdapter: SpecFormatAdapter = {
  id: "microsoft-graph",
  fetch: (input) =>
    buildMicrosoftGraphOpenApiSpec(
      {
        ...(input.urls[0] ? { specUrl: input.urls[0] } : {}),
      },
      input.httpClientLayer,
    ).pipe(
      Effect.map((graphSpec) => ({
        specText: graphSpec.specText,
        sourceUrl: graphSpec.specUrl,
        baseUrl: graphSpec.baseUrl,
        authenticationTemplate: graphSpec.authenticationTemplate,
        // Stream the full Graph source straight to persisted bindings. This is
        // the measured Workers contention/OOM path from the Microsoft plugin:
        // structural split stays serial and avoids materializing the 37MB tree.
        keepPathItem: microsoftGraphKeepPathItem(graphSpec),
        config: {
          microsoftGraphPresetIds: graphSpec.presetIds,
          microsoftGraphCustomScopes: graphSpec.customScopes,
          microsoftGraphScopes: graphSpec.scopes,
          microsoftGraphExactPaths: graphSpec.exactPaths,
          microsoftGraphPathPrefixes: graphSpec.pathPrefixes,
          microsoftGraphTagPrefixes: graphSpec.tagPrefixes,
          microsoftGraphCoversFullGraph: graphSpec.coversFullGraph,
          microsoftGraphAuthorizationUrl: graphSpec.authorizationUrl,
          microsoftGraphTokenUrl: graphSpec.tokenUrl,
          microsoftGraphClientCredentialsTokenUrl: graphSpec.clientCredentialsTokenUrl,
        },
      })),
    ),
};
