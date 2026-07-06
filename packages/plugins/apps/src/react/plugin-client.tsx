import { defineClientPlugin } from "@executor-js/sdk/client";

import { appsIntegrationPlugin } from "./source-plugin";

export { appsIntegrationPlugin } from "./source-plugin";
export * from "./custom-tools-client";

export default defineClientPlugin({
  id: "apps",
  integrationPlugin: appsIntegrationPlugin,
});
