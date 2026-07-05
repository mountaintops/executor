import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";

// Point config at a throwaway data dir before importing the app graph.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-apps-"));

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  // Boot the REAL self-host app handler (makeSelfHostApp), which mounts the apps
  // extension route under /api/apps/*.
  const { makeSelfHostApiHandler } = await import("./app");
  const app = await makeSelfHostApiHandler();
  handler = app.handler;
  dispose = app.dispose;
});
afterAll(() => dispose());

// A minimal published app: one tool that writes the scope db, and a ui view.
const FILES = {
  "tools/note.ts":
    `import { z } from "zod";\nimport { defineTool } from "executor:app";\n` +
    `export default defineTool({ description: "Save a note", input: z.object({ text: z.string() }), ` +
    `async handler({ text }, { db }) { await db.sql\`CREATE TABLE IF NOT EXISTS notes (t TEXT)\`; ` +
    `await db.sql\`INSERT INTO notes (t) VALUES (\${text})\`; const rows = await db.sql\`SELECT COUNT(*) AS n FROM notes\`; return { count: Number(rows[0].n) }; } });`,
  "ui/board.tsx":
    `import { config } from "executor:ui";\nconfig({ title: "Board", maxHeight: 400 });\n` +
    `export default function App() { return null; }`,
};

test("apps HTTP surface is mounted: publish then serve the ui bundle", async () => {
  // Publish over the booted server's /api/apps/:scope/publish route.
  const publishRes = await handler(
    new Request("http://localhost/api/apps/default/publish", {
      method: "POST",
      body: JSON.stringify({ files: FILES }),
    }),
  );
  expect(publishRes.status).toBe(200);
  const published = (await publishRes.json()) as {
    descriptor: { tools: { name: string }[]; ui: { name: string }[] };
  };
  expect(published.descriptor.tools.map((t) => t.name)).toEqual(["note"]);
  expect(published.descriptor.ui.map((u) => u.name)).toEqual(["board"]);

  // The ui bundle is served (compiled JS) with its title header.
  const uiRes = await handler(
    new Request("http://localhost/api/apps/default/ui/board", { method: "GET" }),
  );
  expect(uiRes.status).toBe(200);
  expect(uiRes.headers.get("content-type")).toContain("javascript");
  expect(uiRes.headers.get("x-ui-title")).toBe("Board");

  // Invoke the tool (scope-db path is live in the running server).
  const invokeRes = await handler(
    new Request("http://localhost/api/apps/default/tools/note", {
      method: "POST",
      body: JSON.stringify({ args: { text: "hello" }, bindings: {} }),
    }),
  );
  expect(invokeRes.status).toBe(200);
  const invoked = (await invokeRes.json()) as { result: { count: number } };
  expect(invoked.result.count).toBe(1);
}, 30_000);
