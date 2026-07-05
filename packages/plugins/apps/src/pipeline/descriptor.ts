// ---------------------------------------------------------------------------
// The versioned app descriptor — the single source the pipeline extracts from
// source at publish. Catalog rows, schedules, ui resources and the skills index
// are all PROJECTIONS of this (FDI: publish is the compiler; nothing is
// hand-written). Identity is the file path throughout — there are no authored
// `name`/`id` fields (skills carry a spec-mandated frontmatter `name` we
// validate == dir name, but identity is still the path).
// ---------------------------------------------------------------------------

/** Descriptor schema version. Bumped on any breaking shape change. */
export const DESCRIPTOR_VERSION = 1 as const;

export type ConnectionDecl =
  | { readonly kind: "single"; readonly integration: string; readonly description?: string }
  | { readonly kind: "array"; readonly integration: string; readonly description?: string }
  | { readonly kind: "catalog" };

export interface ToolDescriptor {
  /** Path identity, e.g. `issues-sync` (from `tools/issues-sync.ts`). */
  readonly name: string;
  readonly sourcePath: string;
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
  readonly description: string;
  readonly connections: Readonly<Record<string, ConnectionDecl>>;
  readonly schedule?: { readonly cron: string; readonly timezone?: string };
}

export interface UiDescriptor {
  readonly name: string;
  readonly sourcePath: string;
  /** Compiled browser bundle content hash (blob key). */
  readonly bundleHash: string;
  readonly title?: string;
  readonly maxHeight?: number;
}

export interface SkillDescriptor {
  /** Directory name == frontmatter `name` (validated at publish). */
  readonly name: string;
  readonly sourcePath: string;
  readonly description: string;
  /** Full SKILL.md body (blob key). */
  readonly bodyHash: string;
}

export interface AppDescriptor {
  readonly version: typeof DESCRIPTOR_VERSION;
  readonly scope: string;
  /** The snapshot (commit hash) this descriptor was extracted from. */
  readonly snapshotId: string;
  readonly tools: readonly ToolDescriptor[];
  readonly workflows: readonly WorkflowDescriptor[];
  readonly ui: readonly UiDescriptor[];
  readonly skills: readonly SkillDescriptor[];
  /** Shared JSON-schema `$defs` reachable from tool schemas. */
  readonly definitions?: Record<string, unknown>;
}
