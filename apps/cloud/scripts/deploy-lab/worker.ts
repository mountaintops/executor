// ---------------------------------------------------------------------------
// executor-cloud-deploy-lab, a CUT-DOWN staging worker used ONLY to validate
// the upload->staged-promotion deploy mechanics (versions, gradual deployments,
// version affinity, rollback) and the patched MCP bridge transport under real
// Cloudflare deployment machinery.
//
// It mounts the REAL shared MCP session Durable Object base
// (`McpAgentSessionDOBase` from @executor-js/cloudflare) with the REAL patched
// `agents` transport (patches/agents@0.17.3.patch, the worker<->DO websocket
// bridge). The heavy cloud seams (Postgres/Hyperdrive, WorkOS, Autumn billing,
// Sentry/OTEL) are replaced with trivial stubs so the worker boots with NO
// production secrets. The MCP transport path, session create, in-flight
// tools/call, POST-stream disconnect + GET replay, runs for real.
//
// NEVER point this at production. workers_dev only, no routes/domains/crons.
// ---------------------------------------------------------------------------
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import * as z from "zod/v4";

import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type McpSessionInit,
  type McpSessionProps,
  type SessionDbHandle,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/agent-durable-object";
import {
  withVerifiedIdentityHeaders,
  readElicitationMode,
} from "@executor-js/cloudflare/mcp/do-headers";
import { defaultMcpResource } from "@executor-js/host-mcp";

// The version label is injected per-version via a `vars` override at
// `wrangler versions upload` time (`--var LAB_VERSION:vN`). Every response
// echoes it so a client can observe WHICH worker version served each request
// (the crux of the affinity experiment) without needing dashboard access.
interface LabEnv extends Cloudflare.Env {
  readonly MCP_SESSION: DurableObjectNamespace;
  readonly LAB_VERSION?: string;
}

// A no-op ExecutionEngine stub. The base only touches the engine on the
// pause/resume approval path; a plain tools/call runs the tool handler
// directly, so these are never exercised by the deploy experiments. Shape
// mirrors packages/core/execution/src/engine.ts::ExecutionEngine.
const makeStubEngine = () =>
  // oxlint-disable-next-line executor/no-double-cast -- lab-only test double: the engine is never exercised by the deploy experiments (no pause/resume), so a structural stub standing in for the full ExecutionEngine is intentional.
  ({
    execute: () => Effect.succeed({ result: "lab-execute" }),
    executeWithPause: () =>
      Effect.succeed({ status: "completed", result: { result: "lab-execute" } }),
    resume: () => Effect.succeed({ status: "completed", result: { result: "lab-resume" } }),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("lab stub engine"),
  }) as unknown as BuiltMcpServer["engine"];

// The lab MCP server exposes a single `execute` tool that sleeps for a
// caller-supplied duration and echoes a marker, enough to hold a ~60s
// in-flight tool call open across a mid-call deploy (experiments 1 & 5).
const buildLabMcpServer = (version: string): McpServer => {
  const server = new McpServer({ name: "executor-cloud-deploy-lab", version: "0.0.1" });
  server.registerTool(
    "execute",
    {
      description: "Sleep for delayMs then echo marker. Lab-only, no real execution engine.",
      inputSchema: {
        code: z
          .string()
          .optional()
          .describe("ignored (compat with the real execute tool signature)"),
        delayMs: z.number().optional().describe("how long to sleep before responding"),
        marker: z.string().optional().describe("string echoed back in the result"),
      },
    },
    async (args: { code?: string; delayMs?: number; marker?: string }) => {
      const delayMs = typeof args.delayMs === "number" ? args.delayMs : 0;
      const marker = args.marker ?? "LAB_RESULT";
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ marker, servedByVersion: version }) },
        ],
      };
    },
  );
  return server;
};

// The lab DO: the REAL base + REAL patched transport, trivial seams.
export class McpSessionDOSqlite extends McpAgentSessionDOBase<LabEnv> {
  protected openSessionDb(): SessionDbHandle {
    return { end: () => undefined };
  }

  protected resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
    return Effect.succeed({
      organizationId: token.organizationId,
      organizationName: "Deploy Lab Org",
      userId: token.userId,
      elicitationMode:
        token.elicitationMode === "browser" || token.elicitationMode === "native"
          ? token.elicitationMode
          : "model",
      resource: token.resource,
      webOrigin: token.webOrigin,
    });
  }

  protected buildMcpServer(): Effect.Effect<BuiltMcpServer> {
    const version = (this.env as LabEnv).LAB_VERSION ?? "unknown";
    return Effect.succeed({
      mcpServer: buildLabMcpServer(version),
      engine: makeStubEngine(),
    });
  }
}

// A stub auth layer: accepts ANY bearer, mints a fixed principal. This is the
// ONLY thing standing in for the real WorkOS auth provider, the session
// engine, DO, transport, and bridge below are the real, patched code.
const LAB_PRINCIPAL = { accountId: "lab-user", organizationId: "lab-org" } as const;

const serve = McpAgentSessionDOBase.serve("/mcp", {
  binding: "MCP_SESSION",
  transport: "streamable-http",
}) as { fetch: (req: Request, env: LabEnv, ctx: ExecutionContext) => Promise<Response> };

export default {
  async fetch(request: Request, env: LabEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const version = env.LAB_VERSION ?? "unknown";

    // Version-echo endpoint: which worker version is serving THIS request.
    // Used to observe stateless-worker version affinity during a gradual
    // deployment. Also echoes the version-affinity header if the client set it.
    if (url.pathname === "/__lab/version") {
      return new Response(
        JSON.stringify({
          servedByVersion: version,
          receivedVersionKey: request.headers.get("Cloudflare-Workers-Version-Key"),
        }),
        { headers: { "content-type": "application/json", "x-lab-version": version } },
      );
    }

    if (url.pathname !== "/mcp") {
      return new Response("lab worker: only /mcp and /__lab/version", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers":
            "content-type, authorization, mcp-session-id, accept, mcp-protocol-version, last-event-id",
          "access-control-expose-headers": "mcp-session-id",
        },
      });
    }

    // Stub auth: any bearer -> fixed principal. Build props exactly like the
    // real agent-handler so the DO's onStart receives a valid McpSessionProps.
    const props: McpSessionProps = {
      session: {
        organizationId: LAB_PRINCIPAL.organizationId,
        userId: LAB_PRINCIPAL.accountId,
        elicitationMode: readElicitationMode(request),
        resource: defaultMcpResource,
        webOrigin: url.origin,
      },
    };
    (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;

    const forwarded = withVerifiedIdentityHeaders(request, LAB_PRINCIPAL, defaultMcpResource);
    const response = await serve.fetch(forwarded, env, ctx);
    // Stamp the serving worker version on every MCP response header too, so the
    // client can log per-request affinity even for streamed responses.
    const headers = new Headers(response.headers);
    headers.set("x-lab-version", version);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
