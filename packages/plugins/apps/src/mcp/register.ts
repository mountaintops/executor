import { z } from "zod";
import { Effect } from "effect";

import type { AppsRuntime } from "../plugin/runtime";

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
}

export interface McpServerLike {
  registerTool: (
    name: string,
    config: { description?: string; inputSchema?: Record<string, unknown> },
    handler: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult,
  ) => unknown;
  registerResource: (
    name: string,
    uri: string,
    metadata: Record<string, unknown>,
    reader: (uri: URL) => Promise<{ contents: unknown[] }> | { contents: unknown[] },
  ) => unknown;
}

export interface AppsMcpDeps {
  readonly runtime: AppsRuntime;
  /** The scope this MCP session serves (self-host single-tenant). */
  readonly scope: string;
}

const UI_MIME = "application/mcp-resource+json;type=html";

const text = (value: unknown): McpToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
  structuredContent:
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined,
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as never);

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
        return { ...text(cause instanceof Error ? cause.message : String(cause)), isError: true };
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
      inputSchema: { name: z.string().describe("The skill name (== its directory)") },
    },
    async ({ name }) => {
      const descriptor = await run(runtime.getDescriptor(scope));
      const skill = descriptor?.skills.find((s) => s.name === name);
      if (!skill) return { ...text(`no skill named "${name}"`), isError: true };
      const body = await run(runtime.deps.store.getBlob(`skill/${skill.bodyHash}`));
      return text(body ?? "");
    },
  );

  // --- ui views as MCP Apps resources --------------------------------------
  // We register a single dynamic resource whose URI carries the ui name; the
  // reader resolves the compiled bundle + config for that view. `_meta.ui`
  // marks it renderable in an MCP Apps client.
  server.registerResource(
    "apps-ui",
    `ui://${scope}/`,
    { description: "Published app UI views", mimeType: UI_MIME },
    async (uri: URL) => {
      // uri like ui://<scope>/<name>
      const name = uri.pathname.replace(/^\//, "") || uri.hostname;
      const viewName = name.includes("/") ? name.split("/").pop()! : name;
      const bundle = await run(runtime.getUiBundle(scope, viewName));
      if (!bundle) {
        return { contents: [{ uri: uri.toString(), mimeType: "text/plain", text: "not found" }] };
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: UI_MIME,
            text: bundle.code,
            _meta: {
              ui: {
                title: bundle.title,
                maxHeight: bundle.maxHeight,
                csp: { connectDomains: [], resourceDomains: [] },
              },
            },
          },
        ],
      };
    },
  );
};
