import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as YAML from "yaml";

import { MICROSOFT_AUTH_TEMPLATE_SLUG } from "./presets";
import { filterMicrosoftGraphOpenApiSpec } from "./graph";

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

describe("Microsoft Graph OpenAPI filtering", () => {
  it.effect("keeps selected paths and injects delegated OAuth", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access", "User.Read", "Mail.ReadWrite"],
        exactPaths: ["/me"],
        pathPrefixes: ["/me/messages"],
      });
      const doc = YAML.parse(filtered) as {
        readonly paths: Record<string, unknown>;
        readonly components: {
          readonly securitySchemes: Record<string, unknown>;
        };
        readonly security: readonly Record<string, readonly string[]>[];
      };

      expect(Object.keys(doc.paths).sort()).toEqual(["/me", "/me/messages"]);
      expect(doc.components.securitySchemes[MICROSOFT_AUTH_TEMPLATE_SLUG]).toBeDefined();
      expect(doc.security[0]?.[MICROSOFT_AUTH_TEMPLATE_SLUG]).toEqual([
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
      ]);
    }),
  );
});
