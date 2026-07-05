import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The REAL kill test: SIGKILL a child process mid-step, restart over the same
// data dir, and prove the completed step did NOT re-execute. A side-effect file
// written exactly once is the assertion.
//
// Phase 1 (child): start the run; step "write-once" appends one line to the
// marker file, then step "hang" blocks forever. When the child prints "HUNG"
// the side effect has landed and it is stuck in a NOT-journaled step. We
// SIGKILL it there.
//
// Phase 2 (child): resume the run over the same journal DB. "write-once" is
// journaled so it replays without re-running; the run completes.
//
// Assertion: the marker file has exactly ONE line.
// ---------------------------------------------------------------------------

const CHILD = join(import.meta.dirname, "..", "testing", "kill-child.ts");

const runChild = (
  phase: string,
  dbPath: string,
  markerPath: string,
  waitForHung: boolean,
): Promise<{ code: number | null; killed: boolean; stdout: string }> =>
  new Promise((resolve) => {
    const child = spawn("bun", [CHILD, phase, dbPath, markerPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (waitForHung && stdout.includes("HUNG") && !killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("exit", (code) => resolve({ code, killed, stdout }));
  });

describe("WorkflowRunner kill test (SIGKILL mid-step, restart, no double-execute)", () => {
  it("runs a completed step exactly once across a kill+restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apps-kill-"));
    const dbPath = join(dir, "journal.db");
    const markerPath = join(dir, "marker.txt");

    // Phase 1: start, land the side effect, get killed mid-"hang".
    const phase1 = await runChild("1", dbPath, markerPath, true);
    expect(phase1.killed).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    const afterKill = readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(afterKill.length).toBe(1); // side effect happened once before the kill

    // Phase 2: resume over the SAME db; completed step must NOT re-run.
    const phase2 = await runChild("2", dbPath, markerPath, false);
    expect(phase2.code).toBe(0);
    expect(phase2.stdout).toContain("STATUS:completed");

    const finalLines = readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean);
    expect(finalLines.length).toBe(1); // STILL exactly one line: no double-execute
  }, 60_000);
});
