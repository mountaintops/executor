import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { makeCtxResolver } from "./apps-resolver";

// ---------------------------------------------------------------------------
// Finding 4 regression: a missing/misnamed credential binding must fail with a
// typed BindingError naming the role + surface, and must make NO upstream call.
// Before the fix the resolver fell back to `conns[0]` and dispatched the request
// with SOME OTHER connection's credential.
//
// We build a fake ctx whose connection list does NOT contain the requested name,
// with an HttpClient that flags if it is ever invoked. The assertion: a
// BindingError, and the http client was never touched (the "emulator ledger" is
// empty).
// ---------------------------------------------------------------------------

describe("apps ClientResolver missing-binding (Fix 4)", () => {
  it("fails typed and makes no upstream call when the bound connection is absent", async () => {
    let httpCalled = false;
    // A stub HttpClient layer that records any dispatch. If the resolver fell
    // back to conns[0] it would build a request and call `execute`.
    // oxlint-disable-next-line executor/no-double-cast -- test double: only execute is implemented and the test asserts it is never called
    const httpLayer = Layer.succeed(HttpClient.HttpClient)({
      execute: () => {
        httpCalled = true;
        return Effect.die("http should never be called for a missing binding");
      },
    } as unknown as HttpClient.HttpClient);

    // The ctx exposes a DIFFERENT connection than the one the binding names.
    const ctx = {
      httpClientLayer: httpLayer,
      connections: {
        list: () =>
          Effect.succeed([
            {
              owner: "user",
              name: "some-other-connection",
              integration: "github",
              config: { baseUrl: "http://127.0.0.1:1/emulator" },
            },
          ]),
        resolveValue: () => Effect.succeed("tok"),
      },
      core: { integrations: { get: () => Effect.succeed(null) } },
    };

    const resolver = makeCtxResolver(ctx);

    const exit = await Effect.runPromiseExit(
      resolver.call({
        integration: "github",
        // The binding names a connection that does NOT exist in the list.
        connection: "the-bound-one",
        path: ["repos", "listForAuthenticatedUser"],
        args: [{}],
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    // The typed BindingError names the role + surface and explains the refusal.
    const serialized = JSON.stringify(exit);
    expect(serialized).toContain("BindingError");
    expect(serialized).toContain("the-bound-one");
    expect(serialized).toContain("refusing to");

    // No upstream call was made (the ledger stayed empty).
    expect(httpCalled).toBe(false);
  });
});
