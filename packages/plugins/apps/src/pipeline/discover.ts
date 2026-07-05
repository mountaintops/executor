import { Data } from "effect";

// ---------------------------------------------------------------------------
// discover — the pipeline's first stage: a filesystem-shape validation over the
// flat scope layout, with ZERO imports (eve's discover/compile split). It gives
// instant diagnostics before any bundling. The flat layout is:
//   tools/<name>.ts   workflows/<name>.ts   ui/<name>.tsx
//   skills/<name>/SKILL.md
// Identity is the path: `tools/issues-sync.ts` -> tool `issues-sync`.
// ---------------------------------------------------------------------------

export interface FileDiagnostic {
  readonly path: string;
  readonly message: string;
}

/** Typed publish failure carrying per-file diagnostics. Nothing is persisted on
 *  a failed publish (the caller aborts the transaction). */
export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
  readonly stage: "discover" | "bundle" | "collect" | "project";
  readonly diagnostics: readonly FileDiagnostic[];
}> {}

export type ArtifactKind = "tool" | "workflow" | "ui" | "skill";

export interface DiscoveredArtifact {
  readonly kind: ArtifactKind;
  /** Path identity (e.g. `issues-sync`). For skills this is the dir name. */
  readonly name: string;
  /** The entry file path in the set (e.g. `tools/issues-sync.ts`, or
   *  `skills/issues-brief/SKILL.md`). */
  readonly entry: string;
}

export interface DiscoverResult {
  readonly artifacts: readonly DiscoveredArtifact[];
}

const TOOL_RE = /^tools\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const WORKFLOW_RE = /^workflows\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const UI_RE = /^ui\/([a-z0-9][a-z0-9-]*)\.(tsx|ts|jsx|js)$/;
const SKILL_RE = /^skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/;

// Parse `name:` / `description:` from a SKILL.md frontmatter block.
const parseFrontmatter = (body: string): Record<string, string> => {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};

/** Validate the flat layout and enumerate artifacts. Pure over the file set;
 *  imports nothing. Skills' frontmatter `name` must equal the directory name
 *  (agentskills.io spec-mandated redundancy, validated here). */
export const discover = (files: ReadonlyMap<string, string>): DiscoverResult | PublishError => {
  const diagnostics: FileDiagnostic[] = [];
  const artifacts: DiscoveredArtifact[] = [];
  const seen = new Set<string>();

  for (const [path, contents] of files) {
    if (path === "executor.json") continue;
    // Ignore companion files under a skill dir (scripts/, references/, assets/).
    if (/^skills\/[a-z0-9-]+\/(?!SKILL\.md)/.test(path)) continue;

    let m: RegExpMatchArray | null;
    if ((m = path.match(TOOL_RE))) {
      artifacts.push({ kind: "tool", name: m[1], entry: path });
    } else if ((m = path.match(WORKFLOW_RE))) {
      artifacts.push({ kind: "workflow", name: m[1], entry: path });
    } else if ((m = path.match(UI_RE))) {
      artifacts.push({ kind: "ui", name: m[1], entry: path });
    } else if ((m = path.match(SKILL_RE))) {
      const dirName = m[1];
      const fm = parseFrontmatter(contents);
      if (!fm.name) {
        diagnostics.push({
          path,
          message: "skill SKILL.md is missing required frontmatter `name`",
        });
      } else if (fm.name !== dirName) {
        diagnostics.push({
          path,
          message: `skill frontmatter name "${fm.name}" must equal the directory name "${dirName}"`,
        });
      }
      if (!fm.description) {
        diagnostics.push({
          path,
          message: "skill SKILL.md is missing required frontmatter `description`",
        });
      }
      artifacts.push({ kind: "skill", name: dirName, entry: path });
    } else if (/^(tools|workflows|ui|skills)\//.test(path)) {
      // A file under a known artifact dir that doesn't match the shape.
      diagnostics.push({
        path,
        message: `file does not match the expected layout for its directory (${path.split("/")[0]}/)`,
      });
    }
    // Files outside the known dirs are relative-import companions; the bundler
    // resolves them from the file set, so they need no discovery entry.

    // Duplicate identity within a kind.
    const key = `${path.split("/")[0]}:${artifacts.at(-1)?.name}`;
    if (artifacts.length && seen.has(key)) {
      diagnostics.push({ path, message: `duplicate artifact identity: ${key}` });
    }
    seen.add(key);
  }

  if (diagnostics.length > 0) {
    return new PublishError({
      message: `discover found ${diagnostics.length} problem(s)`,
      stage: "discover",
      diagnostics,
    });
  }

  return { artifacts };
};
