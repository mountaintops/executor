import { Effect } from "effect";

import type { ArtifactStore, FileSet, SnapshotId } from "../seams/artifact-store";
import type { ToolSandbox } from "../seams/tool-sandbox";
import { bundleEntry } from "./bundle";
import {
  DESCRIPTOR_VERSION,
  type AppDescriptor,
  type ConnectionDecl,
  type SkillDescriptor,
  type ToolDescriptor,
  type UiDescriptor,
  type WorkflowDescriptor,
} from "./descriptor";
import { discover, PublishError, type DiscoveredArtifact } from "./discover";

// ---------------------------------------------------------------------------
// publish — the compiler. discover (fs-shape) -> bundle (esbuild, platform
// external) -> collect (import in the sandbox with nothing bound; define*
// returns descriptors; run twice + byte-compare = determinism) -> project
// (commit the snapshot + emit the versioned descriptor whose projections the
// caller writes in one transaction). Nothing is persisted on failure; the
// caller only commits when this succeeds.
//
// This function is pure w.r.t. persistence EXCEPT it (a) commits the snapshot to
// the ArtifactStore (immutable, content-addressed — safe to leave even on a
// later failure) and (b) writes ui/skill blobs via the injected `putBlob`
// (content-addressed, idempotent). Catalog/schedule/journal projections are the
// caller's transaction.
// ---------------------------------------------------------------------------

/** Content-addressed blob writer (SHA-256 hex key -> value). Idempotent. */
export type PutBlob = (hash: string, value: string) => Effect.Effect<void, PublishError>;

export interface PublishInput {
  readonly scope: string;
  readonly files: FileSet;
  readonly commitMessage?: string;
}

export interface PublishOutput {
  readonly snapshotId: SnapshotId;
  readonly descriptor: AppDescriptor;
}

const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  });

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

// The raw shape the sandbox collect returns for one artifact's descriptor.
interface CollectedDescriptor {
  readonly kind: "tool" | "workflow";
  readonly description?: string;
  readonly connections?: Record<
    string,
    { decl: string; integration?: string; description?: string }
  >;
  readonly annotations?: ToolDescriptor["annotations"];
  readonly schedule?: { cron: string; timezone?: string };
  readonly inputJsonSchema?: unknown;
  readonly outputJsonSchema?: unknown;
}

const toConnectionDecls = (
  raw: CollectedDescriptor["connections"],
): Record<string, ConnectionDecl> => {
  const out: Record<string, ConnectionDecl> = {};
  for (const [role, c] of Object.entries(raw ?? {})) {
    if (c.decl === "array") {
      out[role] = { kind: "array", integration: c.integration ?? "", description: c.description };
    } else if (c.decl === "catalog") {
      out[role] = { kind: "catalog" };
    } else {
      out[role] = { kind: "single", integration: c.integration ?? "", description: c.description };
    }
  }
  return out;
};

export interface PublishDeps {
  readonly artifactStore: ArtifactStore;
  readonly sandbox: ToolSandbox;
  readonly putBlob: PutBlob;
}

export const publish = (
  deps: PublishDeps,
  input: PublishInput,
): Effect.Effect<PublishOutput, PublishError> =>
  Effect.gen(function* () {
    // --- discover (fs-shape, zero imports) --------------------------------
    const discovered = discover(input.files);
    if (discovered instanceof PublishError) return yield* Effect.fail(discovered);

    // --- commit the snapshot (immutable, content-addressed) ---------------
    const scopeStore = yield* deps.artifactStore
      .forScope(input.scope)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({ message: cause.message, stage: "project", diagnostics: [] }),
        ),
      );
    const meta = yield* scopeStore
      .commit(input.files, input.commitMessage ?? `publish ${new Date().toISOString()}`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({ message: cause.message, stage: "project", diagnostics: [] }),
        ),
      );

    const tools: ToolDescriptor[] = [];
    const workflows: WorkflowDescriptor[] = [];
    const ui: UiDescriptor[] = [];
    const skills: SkillDescriptor[] = [];

    const codeArtifacts = discovered.artifacts.filter(
      (a): a is DiscoveredArtifact => a.kind === "tool" || a.kind === "workflow",
    );

    // --- bundle + collect each tool/workflow ------------------------------
    for (const artifact of codeArtifacts) {
      const bundle = yield* bundleEntry({ files: input.files, entry: artifact.entry }).pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({
              message: cause.message,
              stage: "bundle",
              diagnostics: [{ path: artifact.entry, message: cause.message }],
            }),
        ),
      );
      const collected = yield* deps.sandbox.collect(bundle.code).pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({
              message: cause.message,
              stage: "collect",
              diagnostics: [{ path: artifact.entry, message: cause.message }],
            }),
        ),
      );
      const raw = collected.artifacts.default?.descriptor as CollectedDescriptor | undefined;
      if (!raw) {
        return yield* Effect.fail(
          new PublishError({
            message: `no descriptor collected from ${artifact.entry}`,
            stage: "collect",
            diagnostics: [{ path: artifact.entry, message: "define* did not run" }],
          }),
        );
      }
      const connections = toConnectionDecls(raw.connections);
      if (artifact.kind === "tool") {
        tools.push({
          name: artifact.name,
          sourcePath: artifact.entry,
          description: raw.description ?? "",
          connections,
          inputSchema: raw.inputJsonSchema,
          outputSchema: raw.outputJsonSchema,
          annotations: raw.annotations,
        });
      } else {
        workflows.push({
          name: artifact.name,
          sourcePath: artifact.entry,
          description: raw.description ?? "",
          connections,
          schedule: raw.schedule,
        });
      }
    }

    // --- ui: bundle for the browser, store the bundle as a blob -----------
    for (const artifact of discovered.artifacts.filter((a) => a.kind === "ui")) {
      const bundle = yield* bundleEntry({ files: input.files, entry: artifact.entry }).pipe(
        Effect.mapError(
          (cause) =>
            new PublishError({
              message: cause.message,
              stage: "bundle",
              diagnostics: [{ path: artifact.entry, message: cause.message }],
            }),
        ),
      );
      const hash = yield* sha256Hex(bundle.code);
      yield* deps.putBlob(`ui/${hash}`, bundle.code);
      // Pull title/maxHeight from a `config({...})` call if present (best-effort
      // static scan; the shell also reads config() at mount).
      const source = input.files.get(artifact.entry) ?? "";
      const titleMatch = source.match(/title:\s*["'`]([^"'`]+)["'`]/);
      const maxHeightMatch = source.match(/maxHeight:\s*(\d+)/);
      ui.push({
        name: artifact.name,
        sourcePath: artifact.entry,
        bundleHash: hash,
        title: titleMatch?.[1],
        maxHeight: maxHeightMatch ? Number(maxHeightMatch[1]) : undefined,
      });
    }

    // --- skills: store the SKILL.md body, index name + description --------
    for (const artifact of discovered.artifacts.filter((a) => a.kind === "skill")) {
      const body = input.files.get(artifact.entry) ?? "";
      const fm = parseFrontmatter(body);
      const hash = yield* sha256Hex(body);
      yield* deps.putBlob(`skill/${hash}`, body);
      skills.push({
        name: artifact.name,
        sourcePath: artifact.entry,
        description: fm.description ?? "",
        bodyHash: hash,
      });
    }

    const descriptor: AppDescriptor = {
      version: DESCRIPTOR_VERSION,
      scope: input.scope,
      snapshotId: meta.id,
      tools,
      workflows,
      ui,
      skills,
    };

    return { snapshotId: meta.id, descriptor };
  });
