import { makeCloudflareApp } from "./app";
import { loadConfig, type CloudflareEnv } from "./config";
import { makeSalesforceOAuthHandler } from "./auth/salesforce-oauth";

export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

let handlerPromise: Promise<{
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}> | null = null;

const resolveHandler = (env: CloudflareEnv) => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler, mcpAgentHandler }) => ({
      app: toWebHandler().handler,
      mcp: mcpAgentHandler,
    }));
  }
  return handlerPromise;
};

export default {
  fetch: async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    // Directly intercept all Salesforce OAuth, REST Proxy, MCP Proxy, Webhooks & OpenAPI Spec routes
    if (url.pathname.includes("/sf") || url.pathname.includes("/oauth") || url.pathname.includes("/webhook") || url.pathname.includes("openapi")) {
      const config = loadConfig(env);
      const sfOAuthHandler = makeSalesforceOAuthHandler(config, env);
      return sfOAuthHandler(request);
    }

    if (url.pathname === "/mcp") {
      const serve = await resolveHandler(env);
      return serve.mcp(request, env, ctx);
    }

    const serve = await resolveHandler(env);
    return serve.app(request);
  },
};
