import { Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { dbProviderLayer, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";
import { preloadQuickJs } from "./quickjs";
import { makeSalesforceOAuthHandler } from "./auth/salesforce-oauth";

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const plugins = makeCloudflarePlugins(config.secretKey);

  await preloadQuickJs();

  const dbHandle = await createD1ExecutorDb(env.DB, env.BLOBS);
  const identityLayer = cloudflareAccessIdentityLayer(config);
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);
  const sfOAuthHandler = makeSalesforceOAuthHandler(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider },
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      account: cloudflareAccountMiddleware(config),
    },
    extensions: {
      routes: [
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
        HttpRouter.add("*", "/api/oauth/*", HttpEffect.fromWebHandler(sfOAuthHandler)),
        HttpRouter.add("*", "/api/sf/*", HttpEffect.fromWebHandler(sfOAuthHandler)),
        HttpRouter.add("*", "/webhook", HttpEffect.fromWebHandler(sfOAuthHandler)),
        HttpRouter.add("*", "/api/webhook", HttpEffect.fromWebHandler(sfOAuthHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
