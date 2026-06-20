import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { microsoftPlugin } from "./plugin";
import { MICROSOFT_AUTH_TEMPLATE_SLUG, MICROSOFT_GRAPH_OPENAPI_URL } from "./presets";

const graphFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me:
    get:
      operationId: me.GetUser
      responses:
        "200":
          description: OK
  /me/messages:
    get:
      operationId: me.messages.ListMessages
      responses:
        "200":
          description: OK
  /me/events:
    get:
      operationId: me.events.ListEvents
      responses:
        "200":
          description: OK
  /sites:
    get:
      operationId: sites.ListSites
      responses:
        "200":
          description: OK
components:
  schemas:
    user:
      type: object
`;

const graphHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url === MICROSOFT_GRAPH_OPENAPI_URL
          ? new Response(graphFixture, {
              status: 200,
              headers: { "content-type": "application/yaml" },
            })
          : new Response("not found", { status: 404 }),
      ),
    ),
  ),
);

const graphPlugins = () =>
  [microsoftPlugin({ httpClientLayer: graphHttpClientLayer }), memoryCredentialsPlugin()] as const;

describe("Microsoft Graph provider", () => {
  it.effect("adds a selected Graph workload source with one OAuth template", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        const result = yield* executor.microsoft.addGraph({
          presetIds: ["profile", "mail"],
          slug: "microsoft_graph",
          description: "Microsoft Graph",
        });

        expect(String(result.slug)).toBe("microsoft_graph");

        const config = yield* executor.microsoft.getConfig("microsoft_graph");
        expect(config?.microsoftGraphPresetIds).toEqual(["profile", "mail"]);
        expect(config?.microsoftGraphScopes).toEqual([
          "offline_access",
          "User.Read",
          "Mail.ReadWrite",
          "Mail.Send",
        ]);

        const oauth = config?.authenticationTemplate?.find((entry) => entry.kind === "oauth2");
        expect(oauth?.kind === "oauth2" ? oauth.slug : undefined).toBe(
          AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("microsoft_graph"),
          template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("me.getUser");
        expect(toolNames).toContain("me.messagesListMessages");
        expect(toolNames).not.toContain("sites.listSites");
      }),
    ),
  );
});
