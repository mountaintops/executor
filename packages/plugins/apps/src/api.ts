// HTTP + plugin surface for @executor-js/plugin-apps.
export {
  appsPlugin,
  APPS_INTEGRATION_SLUG,
  APPS_PLUGIN_ID,
  APPS_CONNECTION_PREFIX,
  connectionNameForScope,
  scopeFromConnection,
  type AppsPluginOptions,
} from "./plugin/apps-plugin";
export { makeAppsHttpRoutes, type AppsHttpDeps } from "./http/routes";
export { registerAppsMcp, type AppsMcpDeps, type McpServerLike } from "./mcp/register";
export { makeSelfHostApps, type SelfHostApps, type SelfHostAppsOptions } from "./plugin/self-host";
export { makeSqliteAppsStore } from "./backing/sqlite-apps-store";
export { BindingError, type ClientResolver, type Bindings } from "./plugin/bindings";
