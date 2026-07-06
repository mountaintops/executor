// ---------------------------------------------------------------------------
// The versioned app descriptor — the single source the pipeline extracts from
// source at publish. Catalog rows, schedules, ui resources and the skills index
// are all PROJECTIONS of this (FDI: publish is the compiler; nothing is
// hand-written). Identity is the file path throughout — there are no authored
// `name`/`id` fields (skills carry a spec-mandated frontmatter `name` we
// validate == dir name, but identity is still the path).
// ---------------------------------------------------------------------------

/** Descriptor schema version. Bumped on any breaking shape change. A reader
 *  refuses a descriptor from a version it does not understand. */
export const DESCRIPTOR_VERSION = 1 as const;

/** Where an entry came from: path + content hash. Lets a projection point back
 *  at the exact source bytes without re-reading the snapshot, and makes the
 *  determinism byte-compare include per-entry provenance. (Grafted from C.) */
export interface ModuleSourceRef {
  /** Path within the scope repo, e.g. `tools/issues-sync.ts`. */
  readonly path: string;
  /** SHA-256 of the source bytes (hex). */
  readonly sourceHash: string;
}

/** The toolchain that produced the bundles, recorded so a re-collect on a
 *  different esbuild is not falsely claimed byte-identical. (Grafted from C.) */
export interface ToolchainRef {
  readonly bundler: "esbuild";
  readonly bundlerVersion: string;
  readonly target: string;
}

export type ConnectionDecl =
  | { readonly kind: "single"; readonly integration: string; readonly description?: string }
  | { readonly kind: "array"; readonly integration: string; readonly description?: string }
  | { readonly kind: "catalog" };

export interface ToolDescriptor {
  /** Path identity, e.g. `issues-sync` (from `tools/issues-sync.ts`). */
  readonly name: string;
  readonly sourcePath: string;
  /** Path + source-hash provenance for this entry. */
  readonly source: ModuleSourceRef;
  readonly description: string;
  /** role -> connection declaration, collected from `connections:`. */
  readonly connections: Readonly<Record<string, ConnectionDecl>>;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly requiresApproval?: boolean;
  };
}

export interface WorkflowDescriptor {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: ModuleSourceRef;
  readonly description: string;
  readonly connections: Readonly<Record<string, ConnectionDecl>>;
  readonly schedule?: { readonly cron: string; readonly timezone?: string };
}

export interface UiDescriptor {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: ModuleSourceRef;
  /** Compiled browser bundle content hash (blob key). */
  readonly bundleHash: string;
  readonly title?: string;
  readonly maxHeight?: number;
}

export interface SkillDescriptor {
  /** Directory name == frontmatter `name` (validated at publish). */
  readonly name: string;
  readonly sourcePath: string;
  readonly source: ModuleSourceRef;
  readonly description: string;
  /** Full SKILL.md body (blob key). */
  readonly bodyHash: string;
}

export interface AppDescriptor {
  readonly version: typeof DESCRIPTOR_VERSION;
  readonly scope: string;
  /** The snapshot (commit hash) this descriptor was extracted from. */
  readonly snapshotId: string;
  /** The toolchain that produced the compiled bundles. */
  readonly toolchain: ToolchainRef;
  readonly tools: readonly ToolDescriptor[];
  readonly workflows: readonly WorkflowDescriptor[];
  readonly ui: readonly UiDescriptor[];
  readonly skills: readonly SkillDescriptor[];
  /** Shared JSON-schema `$defs` reachable from tool schemas. */
  readonly definitions?: Record<string, unknown>;
}

/** The path inside a committed snapshot where the extracted descriptor is
 *  written, so projections (catalog rows, schedules, ui, skills index) can be
 *  recovered from the commit ALONE (repair / recompute-on-read). */
export const DESCRIPTOR_SNAPSHOT_PATH = ".executor/descriptor.json";

/** Stable, key-sorted JSON serialization used for the determinism byte-compare
 *  and for content hashing. Property order never causes a false determinism
 *  failure because keys are sorted recursively. (Grafted from C.) */
export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: stable JSON serialization must fail loudly on cyclic internal values
    if (seen.has(v)) throw new Error("cyclic value cannot be serialized deterministically");
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const inner = (v as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      out[key] = walk(inner);
    }
    return out;
  };
  return JSON.stringify(walk(value));
};
