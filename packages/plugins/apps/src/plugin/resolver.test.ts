import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { InvokeOptions } from "@executor-js/sdk";

import { makePluginCtxAppsResolver, type AppsResolverPluginCtx } from "./resolver";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("makePluginCtxAppsResolver", () => {
  it("passes caller invoke options through bridged integration calls", async () => {
    const invokeOptions = { onElicitation: "accept-all" } satisfies InvokeOptions;
    let seenAddress = "";
    let seenPayload: unknown;
    let seenOptions: InvokeOptions | undefined;

    const ctx: AppsResolverPluginCtx = {
      connections: {
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
      },
      execute: (address: unknown, payload: unknown, options?: InvokeOptions) =>
        Effect.sync(() => {
          seenAddress = String(address);
          seenPayload = payload;
          seenOptions = options;
          return "called";
        }),
    };

    const resolver = makePluginCtxAppsResolver({ ctx });
    const result = await run(
      resolver.call({
        integration: "github",
        connection: "tools.github.user.main",
        path: ["issues", "listForRepo"],
        args: [{ owner: "acme", repo: "tools" }],
        invokeOptions,
      }),
    );

    expect(result).toBe("called");
    expect(seenAddress).toBe("tools.github.user.main.issues.listForRepo");
    expect(seenPayload).toEqual({ owner: "acme", repo: "tools" });
    expect(seenOptions).toBe(invokeOptions);
  });
});
