import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeGitArtifactStore } from "../backing/git-artifact-store";
import { makeQuickjsToolSandbox } from "../backing/quickjs-tool-sandbox";
import { dailyBriefFileSet } from "../testing/daily-brief";
import { publish, type PutBlob } from "./publish";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const makeDeps = () => {
  const blobs = new Map<string, string>();
  const putBlob: PutBlob = (hash, value) => Effect.sync(() => void blobs.set(hash, value));
  return {
    deps: {
      artifactStore: makeGitArtifactStore({ root: mkdtempSync(join(tmpdir(), "apps-pub-")) }),
      sandbox: makeQuickjsToolSandbox(),
      putBlob,
    },
    blobs,
  };
};

describe("publish pipeline (discover -> bundle -> collect -> project)", () => {
  it("compiles the daily-brief set into a descriptor", async () => {
    const { deps, blobs } = makeDeps();
    const out = await run(publish(deps, { scope: "rhys", files: dailyBriefFileSet() }));

    expect(out.snapshotId).toBeTruthy();
    const d = out.descriptor;
    expect(d.scope).toBe("rhys");
    expect(d.snapshotId).toBe(out.snapshotId);

    // Two tools, one workflow, one ui, one skill.
    const toolNames = d.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["issues-sync", "search-all-mail"]);
    expect(d.workflows.map((w) => w.name)).toEqual(["morning-sync"]);
    expect(d.ui.map((u) => u.name)).toEqual(["dashboard"]);
    expect(d.skills.map((s) => s.name)).toEqual(["issues-brief"]);

    // issues-sync declares a single github connection + a real input schema.
    const sync = d.tools.find((t) => t.name === "issues-sync")!;
    expect(sync.connections.github).toEqual(
      expect.objectContaining({ kind: "single", integration: "github" }),
    );
    expect((sync.inputSchema as { type: string }).type).toBe("object");

    // search-all-mail declares a fan-out gmail connection.
    const mail = d.tools.find((t) => t.name === "search-all-mail")!;
    expect(mail.connections.inboxes).toEqual(
      expect.objectContaining({ kind: "array", integration: "gmail" }),
    );

    // The workflow carries its schedule (extracted for the scheduler).
    expect(d.workflows[0].schedule).toEqual({ cron: "0 9 * * 1-5", timezone: "America/New_York" });

    // ui bundle + skill body were stored as blobs.
    expect(blobs.has(`ui/${d.ui[0].bundleHash}`)).toBe(true);
    expect(blobs.has(`skill/${d.skills[0].bodyHash}`)).toBe(true);
    expect(d.ui[0].title).toBe("GitHub Issues");
    expect(d.ui[0].maxHeight).toBe(720);
    expect(d.skills[0].description).toContain("open GitHub issues");
  });

  it("rejects a skill whose frontmatter name mismatches the dir", async () => {
    const { deps } = makeDeps();
    const files = new Map([
      ["skills/mine/SKILL.md", "---\nname: not-mine\ndescription: x\n---\n# body\n"],
    ]);
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
  });

  it("rejects a bare npm import (npm deps out of scope)", async () => {
    const { deps } = makeDeps();
    const files = new Map([
      [
        "tools/bad.ts",
        `import { defineTool } from "executor:app";\nimport { chunk } from "lodash";\nimport { z } from "zod";\nexport default defineTool({ description: "b", input: z.object({}), async handler(){ return chunk([1,2,3], 2); } });`,
      ],
    ]);
    const exit = await Effect.runPromiseExit(publish(deps, { scope: "s", files }));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause;
      // The failure is a PublishError at the bundle stage.
      expect(JSON.stringify(err)).toContain("bundle");
    }
  });
});
