// Selfhost (browser, recorded): the add-connection modal for a transparent-DCR
// OAuth MCP integration must render its body card, not just a floating tab
// strip. A remote MCP integration that declares an oauth2 method is DCR-capable
// (supportsDynamicRegistration), so the modal skips the app picker. When the
// integration also offers the custom-method "+" the method tab strip renders.
//
// The regression this guards: the OAuth tab's TabsContent card (the "No app to
// choose / automatic setup" explainer) was gated out whenever DCR was active,
// leaving the tab strip with no card under it and a detached-looking border.
// The same gate also made that explainer unreachable dead code. The per-step
// screenshots are the artifact.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

scenario(
  "Connections · the add-connection modal for a transparent-DCR OAuth MCP renders its body card under the tab strip",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;

      // A remote MCP integration declaring an oauth2 method: remote + oauth2 is
      // transparent-DCR (supportsDynamicRegistration true), so the modal skips
      // the BYO-app picker. The server is never dialed here — opening the modal
      // only reads the declared template.
      const server = yield* serveMcpServer(() => makeGreetingMcpServer());
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = `mcp-dcr-card-${randomBytes(3).toString("hex")}`;

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "DCR OAuth MCP",
          endpoint: server.endpoint,
          slug,
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });

      // Remove the integration afterward — selfhost identities share one tenant,
      // so a leaked integration would bleed into other scenarios.
      yield* Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          const dialog = page.getByRole("dialog");

          await step("Open the integration's add-connection modal", async () => {
            await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await dialog.waitFor({ state: "visible" });
          });

          await step("The OAuth tab and the custom-method + are present", async () => {
            await dialog.getByRole("tab", { name: "OAuth" }).waitFor();
            await dialog.getByRole("button", { name: "Add authentication method" }).waitFor();
          });

          await step("The OAuth tab has its body card, not a floating tab strip", async () => {
            // The card the fix restores: the DCR explainer that anchors the tab
            // strip. Before the fix the TabsContent was gated out for DCR, so
            // this copy was unreachable and the tabs floated with no card.
            await dialog.getByText("No app to choose").waitFor({ timeout: 15_000 });
            await dialog.getByText(/supports automatic setup/).waitFor({ timeout: 15_000 });
          });
        });
      }).pipe(
        Effect.ensuring(
          client.mcp
            .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
            .pipe(Effect.ignore),
        ),
      );
    }),
  ),
);
