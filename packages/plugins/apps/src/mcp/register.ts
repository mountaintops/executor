import { z } from "zod";
import { Effect } from "effect";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppsRuntime } from "../plugin/runtime";
import { UI_APP_MIME } from "./ui-shell";

// ---------------------------------------------------------------------------
// MCP surface for the apps subsystem. Registers, on a McpServer:
//   - `apps_publish` tool: the chat-authoring door (agent publishes a file set)
//   - `apps_list_skills` / `apps_read_skill` tools: published skills over MCP
//   - one `ui://<scope>/<name>` resource per published ui view (MCP Apps),
//     carrying `_meta.ui` so a client renders it, + the raw bundle in the body
//
// Published TOOLS are already catalog citizens through the source plugin, so
// they surface over the host's normal `execute`/tools surface with no extra
// wiring here. This module adds the publish door, skills, and ui resources.
//
// `server` is a minimal structural view of the MCP SDK's McpServer (registerTool
// / registerResource), so this module has no hard dependency on a specific SDK
// version's class.
// ---------------------------------------------------------------------------

interface McpToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpServerLike {
  registerTool: (
    name: string,
    config: {
      description?: string;
      inputSchema?: Record<string, unknown>;
      /** MCP `_meta`. Carries the MCP-Apps UI extension (`ui.resourceUri`) that
       *  links a tool to a `ui://` resource a host renders when it runs. */
      _meta?: Record<string, unknown>;
    },
    handler: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult,
  ) => unknown;
  registerResource: (
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    metadata: Record<string, unknown>,
    reader: (uri: URL) => Promise<{ contents: unknown[] }> | { contents: unknown[] },
  ) => unknown;
  /** The underlying protocol server, exposing the negotiated client capabilities.
   *  Present on the real SDK `McpServer` (`.server`); optional in the structural
   *  view so tests can omit it (treated as "no UI capability"). */
  readonly server?: {
    getClientCapabilities?: () => ClientCapabilitiesLike | undefined;
  };
}

/** The subset of the client's negotiated capabilities we read: the MCP-Apps UI
 *  extension under `extensions["io.modelcontextprotocol/ui"]`. */
export interface ClientCapabilitiesLike {
  readonly experimental?: Record<string, unknown>;
  readonly extensions?: Record<string, unknown>;
}

/** The MCP-Apps UI client-capability extension key (per the MCP Apps spec). */
export const MCP_APPS_UI_CAPABILITY_KEY = "io.modelcontextprotocol/ui";

/** True when the connected client advertises it can render MCP-Apps UI of our
 *  document mime type. A client that does NOT advertise this cannot mount the
 *  `ui://` resource, so `apps_open_ui` returns an HTTP fallback URL instead. */
export const clientSupportsMcpAppsUi = (server: McpServerLike): boolean => {
  const caps = server.server?.getClientCapabilities?.();
  const ui = caps?.extensions?.[MCP_APPS_UI_CAPABILITY_KEY] as
    | { readonly mimeTypes?: readonly string[] }
    | undefined;
  if (!ui) return false;
  // A UI extension with no explicit mime list is treated as generally capable;
  // an explicit list must include our document mime.
  return ui.mimeTypes === undefined || ui.mimeTypes.includes(UI_APP_MIME);
};

export interface AppsMcpDeps {
  readonly runtime: AppsRuntime;
  /** The scope this MCP session serves (self-host single-tenant). */
  readonly scope: string;
  /**
   * Build an absolute HTTP URL to the served HTML document for a ui view (Fix
   * 10). Returned as the fallback when the client cannot render MCP-Apps UI
   * inline, so a terminal/non-UI client still gets a working link instead of an
   * unrenderable resource. Omit when no HTTP base is known (fallback becomes
   * `fallback_unavailable`).
   */
  readonly uiDocumentUrl?: (scope: string, name: string) => string | undefined;
}

const text = (value: unknown): McpToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  structuredContent:
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined,
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as never);

const unknownMessage = (cause: unknown): string => {
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: MCP SDK handler returns unknown failures as tool error text
  return cause instanceof Error ? cause.message : String(cause);
};

export const registerAppsMcp = (server: McpServerLike, deps: AppsMcpDeps): void => {
  const { runtime, scope } = deps;

  // --- the publish door -----------------------------------------------------
  server.registerTool(
    "apps_publish",
    {
      description:
        "Publish a set of app files (tools/, workflows/, ui/, skills/) into this scope. " +
        "Returns the compiled descriptor: which tools, workflows, ui views and skills were published.",
      inputSchema: {
        files: z
          .record(z.string(), z.string())
          .describe("Map of POSIX path -> file contents, e.g. { 'tools/x.ts': '...' }"),
        message: z.string().optional().describe("Publish message"),
      },
    },
    async ({ files, message }) => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK tool handler converts publish failures into MCP tool errors
      try {
        const out = await run(
          runtime.publish({
            scope,
            files: new Map(Object.entries((files as Record<string, string>) ?? {})),
            message: message as string | undefined,
          }),
        );
        return text({
          snapshotId: out.snapshotId,
          tools: out.descriptor.tools.map((t) => t.name),
          workflows: out.descriptor.workflows.map((w) => w.name),
          ui: out.descriptor.ui.map((u) => u.name),
          skills: out.descriptor.skills.map((s) => s.name),
        });
      } catch (cause) {
        return {
          ...text(unknownMessage(cause)),
          isError: true,
        };
      }
    },
  );

  // --- skills over MCP ------------------------------------------------------
  server.registerTool(
    "apps_list_skills",
    {
      description: "List the skills published in this scope (name + description).",
      inputSchema: {},
    },
    async () => {
      const descriptor = await run(runtime.getDescriptor(scope));
      const skills = (descriptor?.skills ?? []).map((s) => ({
        name: s.name,
        description: s.description,
      }));
      return text({ skills });
    },
  );

  server.registerTool(
    "apps_read_skill",
    {
      description: "Read a published skill's full SKILL.md body by name.",
      inputSchema: {
        name: z.string().describe("The skill name (== its directory)"),
      },
    },
    async ({ name }) => {
      const descriptor = await run(runtime.getDescriptor(scope));
      const skill = descriptor?.skills.find((s) => s.name === name);
      if (!skill) return { ...text(`no skill named "${name}"`), isError: true };
      const body = await run(runtime.deps.store.getBlob(`skill/${skill.bodyHash}`));
      return text(body ?? "");
    },
  );

  // --- open-ui tool: the MCP-Apps entry point for a ui view -----------------
  // A UI tool a host runs to MOUNT a published view. It declares the MCP-Apps UI
  // extension (`_meta.ui.resourceUri`) linking it to the view's `ui://` resource,
  // so an MCP-Apps host (Claude / ChatGPT, or the sunpeak host simulation) reads
  // that resource and renders the widget when the tool runs.
  //
  // The extension keys off a CONCRETE resourceUri: a host reads it verbatim, so a
  // `{name}` template placeholder is NOT expanded on read. The daily-brief app's
  // primary view is `dashboard`; that is this tool's fixed target.
  const defaultUiView = "dashboard";
  server.registerTool(
    "apps_open_ui",
    {
      description:
        `Open the published \`${defaultUiView}\` UI view. In a client that supports ` +
        `MCP-Apps UI, this renders the widget inline. In a client that does NOT (e.g. a ` +
        `terminal), it returns a URL to an HTTP-served HTML version of the view instead ` +
        `of rendering, so it never overpromises a widget the client cannot show.`,
      inputSchema: {},
      _meta: { ui: { resourceUri: `ui://${scope}/${defaultUiView}` } },
    },
    async () => {
      const uri = `ui://${scope}/${defaultUiView}`;
      // Fix 10: only claim to render inline when the client actually advertises
      // the MCP-Apps UI capability. Otherwise fall back to an HTTP document URL
      // (honest text + a structured status), never a `_meta.ui` resource link the
      // client can't mount.
      if (clientSupportsMcpAppsUi(server)) {
        return {
          content: [{ type: "text", text: `Opening ${defaultUiView}` }],
          structuredContent: { status: "ui", uri, view: defaultUiView },
          _meta: { ui: { resourceUri: uri } },
        } as McpToolResult;
      }
      const url = deps.uiDocumentUrl?.(scope, defaultUiView);
      if (url) {
        return {
          content: [
            {
              type: "text",
              text:
                `This client can't render MCP-Apps UI inline. Open the \`${defaultUiView}\` ` +
                `view in a browser instead:\n${url}`,
            },
          ],
          structuredContent: { status: "fallback_url", url, view: defaultUiView },
        } as McpToolResult;
      }
      return {
        content: [
          {
            type: "text",
            text:
              `This client can't render MCP-Apps UI inline and no HTTP document URL is ` +
              `configured for the \`${defaultUiView}\` view.`,
          },
        ],
        structuredContent: {
          status: "fallback_unavailable",
          reason: "mcp_apps_unsupported",
          view: defaultUiView,
        },
        isError: true,
      } as McpToolResult;
    },
  );

  // --- ui views as MCP Apps resources --------------------------------------
  // A dynamic resource TEMPLATE whose URI carries the ui view name; the reader
  // resolves the view's self-booting HTML document (React + the executor:ui
  // runtime + the compiled component + the current scope-db rows inlined). It is
  // served as `text/html;profile=mcp-app` so a real MCP-Apps host (Claude /
  // ChatGPT, or the sunpeak host simulation) mounts and renders it. `_meta.ui`
  // marks it renderable.
  //
  // It MUST be a ResourceTemplate (not a fixed URI string): a fixed URI only
  // matches itself, so `resources/read` of `ui://<scope>/<name>` would 404
  // against a `ui://<scope>/` literal. The template `ui://<scope>/{name}`
  // matches every published view under the scope.
  server.registerResource(
    "apps-ui",
    new ResourceTemplate(`ui://${scope}/{name}`, { list: undefined }),
    { description: "Published app UI views", mimeType: UI_APP_MIME },
    async (uri: URL) => {
      // uri like ui://<scope>/<name>
      const name = uri.pathname.replace(/^\//, "") || uri.hostname;
      const viewName = name.includes("/") ? name.split("/").pop()! : name;
      const doc = await run(runtime.getUiDocument(scope, viewName));
      if (!doc) {
        return {
          contents: [{ uri: uri.toString(), mimeType: "text/plain", text: "not found" }],
        };
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: UI_APP_MIME,
            text: doc.html,
            _meta: {
              ui: {
                title: doc.title,
                maxHeight: doc.maxHeight,
                // No external network needed: React, the runtime, and the initial
                // rows are all inline in the document.
                csp: { connectDomains: [], resourceDomains: [] },
              },
            },
          },
        ],
      };
    },
  );
};
