import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
} from "@executor-js/plugin-microsoft";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([microsoftHttpPlugin()] as const);

type ToolView = {
  readonly name: string;
};

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

scenario(
  "Microsoft Graph: default add stores the full Graph operation catalog",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = unique("msgraph_full");
    const connection = ConnectionName.make("main");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* client.microsoft.addGraph({
          payload: {
            presetIds: [...MICROSOFT_GRAPH_DEFAULT_PRESET_IDS],
            customScopes: [],
            slug: integration,
            name: "Microsoft Graph Full Catalog",
          },
        });
        expect(added.slug, "the full Graph source keeps the requested slug").toBe(integration);
        expect(
          added.toolCount,
          "the default Microsoft Graph add extracts a large operation catalog",
        ).toBeGreaterThan(1_000);

        const config = yield* client.microsoft.getConfig({
          params: { slug: integration },
        });
        expect(config?.microsoftGraphPresetIds, "all default Graph groups are persisted").toEqual([
          ...MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
        ]);
        expect(config?.microsoftGraphCoversFullGraph, "the default selection is full Graph").toBe(
          true,
        );

        yield* client.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration: IntegrationSlug.make(integration),
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
            value: "token-xyz",
          },
        });

        const tools = yield* client.tools.list({
          query: { integration: IntegrationSlug.make(integration), connection },
        });
        const names = tools.map((tool: ToolView) => tool.name);
        const messageTools = names.filter((name) => name.toLowerCase().includes("message"));
        const siteTools = names.filter((name) => name.toLowerCase().includes("site"));
        expect(
          messageTools,
          "the retrieved full catalog includes Microsoft message operations",
        ).not.toEqual([]);
        expect(
          siteTools,
          "the retrieved full catalog includes SharePoint site operations",
        ).not.toEqual([]);
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(integration),
              name: connection,
            },
          })
          .pipe(Effect.ignore);
        yield* client.microsoft
          .removeGraph({ params: { slug: IntegrationSlug.make(integration) } })
          .pipe(Effect.ignore);
      }),
    );
  }),
);
