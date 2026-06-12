// Chat theater: agent-chat presentation over REAL mcporter MCP calls — no
// inference, no third-party agent binary. The scenario stays in Effect land
// making real calls; a chat renderer (agent-chat-tui.ts) paints them, so
// the recording reads like a developer chatting with an agent while every
// tool spinner brackets the genuine call it narrates.
//
// Two stages for the same play:
//   - PTY mode (default): the renderer runs in a recorded PTY → terminal.cast
//   - Desk mode (E2E_DESK=1): the renderer runs in a visible xterm on the
//     virtual desktop (events over a FIFO) and the desk's single x11grab
//     films it together with the headed browser — one screen, one mp4
//
// Division of labor in the e2e stack:
//   - chat theater (this): deterministic PRODUCT-flow recordings
//   - replay brain + real client (replay-brain.ts): CLIENT-behavior tests
//     (OpenCode/Claude Code protocol handling), still no inference
//   - real-inference evals: a separate axis entirely — performance
//     distributions, not pass/fail scenarios
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Exit, Fiber } from "effect";

import type { CliSurface } from "../surfaces/cli";

const RENDERER = fileURLToPath(new URL("./agent-chat-tui.ts", import.meta.url));

interface TheaterEvent {
  readonly type: "user" | "assistant" | "tool-start" | "tool-end" | "status" | "done";
  readonly [key: string]: unknown;
}

export interface ChatTheater {
  /** The human's chat line, typed out on screen. */
  readonly user: (text: string) => Effect.Effect<void>;
  /** The agent's reply, streamed on screen. */
  readonly assistant: (text: string) => Effect.Effect<void>;
  /** Run a REAL effect behind a live tool spinner; the spinner runs exactly
   *  as long as the call does and resolves to ✓/✗ with its outcome. */
  readonly tool: <A, E, R>(
    label: string,
    work: Effect.Effect<A, E, R>,
    note?: (result: A) => string | undefined,
  ) => Effect.Effect<A, E, R>;
  /** A dim narrator line (e.g. "waiting for the browser hop"). */
  readonly status: (text: string) => Effect.Effect<void>;
}

const sleep = (ms: number) => new Promise<void>((tick) => setTimeout(tick, ms));

const encode = (event: TheaterEvent) =>
  `${Buffer.from(JSON.stringify(event)).toString("base64")}\n`;

const makeTheater = (push: (event: TheaterEvent) => Effect.Effect<void>): ChatTheater => ({
  user: (text) => push({ type: "user", text }),
  assistant: (text) => push({ type: "assistant", text }),
  status: (text) => push({ type: "status", text }),
  tool: (label, work, note) =>
    Effect.gen(function* () {
      yield* push({ type: "tool-start", label });
      const exit = yield* Effect.exit(work);
      if (Exit.isSuccess(exit)) {
        yield* push({ type: "tool-end", ok: true, note: note?.(exit.value) });
        return exit.value;
      }
      yield* push({ type: "tool-end", ok: false, note: "failed" });
      return yield* exit;
    }),
});

export interface TheaterOptions {
  readonly title: string;
  readonly record: string;
  readonly viewport?: { readonly cols: number; readonly rows: number };
}

/**
 * Open the chat renderer, hand the scenario a ChatTheater handle, and close
 * the session (footer + exit) when the body finishes — success or failure,
 * so the recording always ends cleanly.
 */
export const withChatTheater = <A, E, R>(
  cli: CliSurface,
  options: TheaterOptions,
  body: (theater: ChatTheater) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  process.env.E2E_DESK === "1" ? deskTheater(options, body) : ptyTheater(cli, options, body);

// ---------------------------------------------------------------------------
// PTY mode: renderer in a recorded PTY; events typed in as base64 lines.
// ---------------------------------------------------------------------------

const ptyTheater = <A, E, R>(
  cli: CliSurface,
  options: TheaterOptions,
  body: (theater: ChatTheater) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const queue: TheaterEvent[] = [];
    let closed = false;
    const push = (event: TheaterEvent) =>
      Effect.sync(() => {
        if (!closed) queue.push(event);
      });

    const pump = cli.session(
      ["bun", RENDERER, options.title],
      async (term) => {
        // Don't type until the renderer has painted its header — before that
        // it hasn't set raw mode yet, and the PTY would echo the event line
        // into the recording.
        await term.screen.waitForText(options.title, { timeoutMs: 30_000 });
        const deadline = Date.now() + 30 * 60 * 1000;
        for (;;) {
          const event = queue.shift();
          if (event) {
            await term.keyboard.type(encode(event));
            if (event.type === "done") break;
            continue;
          }
          if (Date.now() > deadline) break;
          await sleep(40);
        }
        await term.screen.waitForText("session complete", { timeoutMs: 60_000 });
      },
      {
        record: options.record,
        viewport: options.viewport ?? { cols: 100, rows: 32 },
      },
    );
    const pumpFiber = yield* Effect.forkChild(Effect.exit(pump));

    const result = yield* Effect.exit(body(makeTheater(push)));
    yield* push({ type: "done" });
    closed = true;
    yield* Fiber.join(pumpFiber);
    return yield* result;
  });

// ---------------------------------------------------------------------------
// Desk mode: renderer in a visible xterm on the virtual desktop; events over
// a FIFO. No cast — the desk's x11grab films the screen.
// ---------------------------------------------------------------------------

const deskTheater = <A, E, R>(
  options: TheaterOptions,
  body: (theater: ChatTheater) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "desk-theater-"));
    const fifo = join(root, "events.fifo");
    spawnSync("mkfifo", [fifo]);

    const xterm = spawn(
      "xterm",
      [
        // -u8 + a UTF-8 locale: the renderer speaks box-drawing and bullets.
        ...["-u8", "-fa", "DejaVu Sans Mono", "-fs", "13"],
        ...["-bg", "#0b0b10", "-fg", "#e8e8ea"],
        ...["-geometry", "112x34+48+40", "-T", options.title],
        ...["-e", "bun", RENDERER, options.title, fifo],
      ],
      { stdio: "ignore", env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
    );
    // Opening the write end parks until the renderer opens the read end.
    const writer = createWriteStream(fifo);
    const push = (event: TheaterEvent) =>
      Effect.sync(() => {
        writer.write(encode(event));
      });

    const result = yield* Effect.exit(body(makeTheater(push)));
    yield* push({ type: "done" });
    yield* Effect.promise(async () => {
      // Renderer acks the footer, lingers for the camera, then exits with
      // its xterm. Don't hang the run on a wedged terminal.
      const ackDeadline = Date.now() + 30_000;
      while (!existsSync(`${fifo}.done`) && Date.now() < ackDeadline) await sleep(200);
      const exitDeadline = Date.now() + 10_000;
      while (xterm.exitCode === null && Date.now() < exitDeadline) await sleep(200);
      if (xterm.exitCode === null) xterm.kill();
      writer.end();
    });
    return yield* result;
  });
