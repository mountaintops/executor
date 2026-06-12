// Film a run: turn a chat-theater run's two real recordings into ONE mp4
// that plays like a screen recording of a developer tabbing between
// full-screen windows — terminal, browser, terminal. No virtual desktop,
// no splice of anything synthetic: both segments are the real recordings,
// cut at the moment the session actually moved between them.
//
//   bun scripts/film.ts runs/<target>/<slug>
//
// Mechanics: the terminal.cast contains dead air while the "user" was in
// the browser (the chat was genuinely idle). We render the cast to video
// with NO idle compression (so cast time == video time), cut it at the
// browser hop, and put the browser session.mp4 in the gap. The hop is
// located by the scenario's narrator line ("…in the browser…"), falling
// back to the largest output gap. Output: film.mp4 next to the inputs —
// the viewer plays it as the session when present.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runDir = resolve(process.argv[2] ?? "");
const castPath = join(runDir, "terminal.cast");
const browserPath = join(runDir, "session.mp4");
if (!existsSync(castPath) || !existsSync(browserPath)) {
  console.error(`film: need terminal.cast + session.mp4 in ${runDir}`);
  process.exit(1);
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "pipe" });
const probeSeconds = (file: string): number =>
  Number(
    execFileSync("ffprobe", [
      ...["-v", "quiet", "-show_entries", "format=duration"],
      ...["-of", "csv=p=0", file],
    ])
      .toString()
      .trim(),
  );

// ---------------------------------------------------------------------------
// Locate the browser hop in cast time.
// ---------------------------------------------------------------------------

interface CastEvent {
  readonly at: number;
  readonly text: string;
}

const events: CastEvent[] = readFileSync(castPath, "utf8")
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as [number, string, string])
  .filter((event) => event[1] === "o")
  .map((event) => ({ at: event[0], text: event[2] }));

const castEnd = events.at(-1)?.at ?? 0;

/** Hop start: the narrator line the scenario prints as it moves to the
 *  browser; hop end: the next visible output after it. Falls back to the
 *  largest inter-event gap (the hop is the only long silence). */
const findHop = (): { start: number; end: number } => {
  const markerIndex = events.findIndex((event) => event.text.includes("in the browser"));
  if (markerIndex !== -1) {
    const start = events[markerIndex];
    const after = events
      .slice(markerIndex + 1)
      .find((event) => event.at > (start?.at ?? 0) + 1 && event.text.trim().length > 0);
    if (start && after) return { start: start.at + 0.8, end: after.at };
  }
  let best = { start: 0, end: 0 };
  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1];
    const current = events[i];
    if (previous && current && current.at - previous.at > best.end - best.start) {
      best = { start: previous.at, end: current.at };
    }
  }
  return best;
};

const hop = findHop();
if (hop.end - hop.start < 2) {
  console.error(`film: no browser hop found in the cast (gap ${hop.end - hop.start}s)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Render + cut + concatenate. One canvas (the browser video's size), every
// segment scaled/padded onto it — full-screen cuts, like tabbing.
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "e2e-film-"));
const castGif = join(work, "cast.gif");
const castVideo = join(work, "cast.mp4");

// No idle compression: cast video time must equal cast event time so the
// cut points land exactly.
run("agg", [
  "--idle-time-limit",
  String(Math.ceil(castEnd) + 60),
  "--font-size",
  "16",
  castPath,
  castGif,
]);
run("ffmpeg", [
  ...["-y", "-i", castGif],
  // agg's gif can have odd dimensions; libx264 requires even.
  ...["-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2"],
  ...["-pix_fmt", "yuv420p", "-r", "24", castVideo],
]);

const browserSeconds = probeSeconds(browserPath);
const FIT =
  "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x0b0b10,setsar=1,fps=24,format=yuv420p";

const filmPath = join(runDir, "film.mp4");
run("ffmpeg", [
  "-y",
  ...["-i", castVideo],
  ...["-i", browserPath],
  "-filter_complex",
  [
    `[0:v]trim=0:${hop.start.toFixed(2)},setpts=PTS-STARTPTS,${FIT}[act1]`,
    `[1:v]${FIT}[act2]`,
    `[0:v]trim=${hop.end.toFixed(2)},setpts=PTS-STARTPTS,${FIT}[act3]`,
    `[act1][act2][act3]concat=n=3:v=1:a=0[out]`,
  ].join(";"),
  ...["-map", "[out]"],
  ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart"],
  filmPath,
]);
rmSync(work, { recursive: true, force: true });

// Register the film in the run's artifact list so the viewer offers it.
const resultPath = join(runDir, "result.json");
if (existsSync(resultPath)) {
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as { artifacts?: string[] };
  if (Array.isArray(result.artifacts) && !result.artifacts.includes("film.mp4")) {
    result.artifacts.push("film.mp4");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resultPath, JSON.stringify(result, null, 1));
  }
}

console.log(
  `film: ${filmPath}\n  act 1 terminal 0–${hop.start.toFixed(1)}s · act 2 browser ${browserSeconds.toFixed(1)}s · act 3 terminal ${(castEnd - hop.end).toFixed(1)}s`,
);
