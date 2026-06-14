import { describe, expect, it } from "@effect/vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";

import { canAutoStartLocalDaemonForHost, isExecutorServerReachable } from "./daemon";

describe("canAutoStartLocalDaemonForHost", () => {
  it("allows loopback hosts", () => {
    expect(canAutoStartLocalDaemonForHost("localhost")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("127.0.0.1")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("[::1]")).toBe(true);
  });

  it("does not treat wildcard binds as loopback", () => {
    expect(canAutoStartLocalDaemonForHost("0.0.0.0")).toBe(false);
    expect(canAutoStartLocalDaemonForHost("::")).toBe(false);
  });
});

describe("isExecutorServerReachable", () => {
  it.effect("probes the unauthenticated /api/health endpoint without forwarding a credential", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            new Promise<{ server: Server; port: number }>((resolve, reject) => {
              const server = createServer((request, response) => {
                const url = new URL(request.url ?? "/", "http://127.0.0.1");
                // The probe must NOT send Authorization, and must hit /api/health.
                if (url.pathname === "/api/health" && !request.headers.authorization) {
                  response.writeHead(200, { "content-type": "text/plain" });
                  response.end("ok");
                  return;
                }
                response.writeHead(404);
                response.end();
              });
              const onError = (error: Error) => reject(error);
              server.once("error", onError);
              server.listen(0, "127.0.0.1", () => {
                server.off("error", onError);
                const address = server.address() as AddressInfo;
                resolve({ server, port: address.port });
              });
            }),
        ),
        ({ server }) =>
          Effect.tryPromise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      const reachable = yield* isExecutorServerReachable({
        baseUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(reachable).toBe(true);
    }),
  );
});
