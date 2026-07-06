import { Effect } from "effect";

import type { AppsRuntime } from "../plugin/runtime";

// ---------------------------------------------------------------------------
// Scheduler — starts due workflow runs from the schedules extracted into the
// descriptor, and re-drives sleeping/waiting runs whose wake time has passed.
// Self-hosted: a single in-process interval ticks and does both. The cloud
// backing (future) is CF cron triggers + the DO alarm. Timezone handling is
// minimal (UTC cron eval); DST-correct local-time cron is a documented cut.
//
// A cron field parser good enough for the extracted schedules ("0 9 * * 1-5"):
// minute hour day-of-month month day-of-week, with `*`, lists, ranges, steps.
// ---------------------------------------------------------------------------

// A cron field parse that CANNOT hang on adversarial input (Fix 8). The naive
// `for (v = lo; v <= hi; v += step)` loops forever on `step <= 0` and iterates
// billions of times on a huge/negative/reversed range. This parser validates
// every part against the field's [min, max] bounds and requires an integer
// `step >= 1`, throwing `CronError` (never looping) on anything malformed. The
// loop is additionally clamped to the field bounds, so the worst case is
// `max - min` iterations (< 60) regardless of input.
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

type ParseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CronError };

const ok = <A>(value: A): ParseResult<A> => ({ ok: true, value });
const cronError = <A = never>(message: string): ParseResult<A> => ({
  ok: false,
  error: new CronError(message),
});

const parseInt10 = (value: string, what: string): ParseResult<number> => {
  if (!/^-?\d+$/.test(value)) return cronError(`invalid ${what}: "${value}"`);
  return ok(Number(value));
};

const parseField = (field: string, min: number, max: number): ParseResult<Set<number>> => {
  const out = new Set<number>();
  if (field === "") return cronError("empty cron field");
  for (const part of field.split(",")) {
    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) return cronError(`invalid cron step in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      const parsedStep = parseInt10(stepPart, "cron step");
      if (!parsedStep.ok) return parsedStep;
      step = parsedStep.value;
      // A step of 0 or negative would never advance the loop -> infinite loop.
      if (step < 1) return cronError(`cron step must be >= 1 (got ${step})`);
    }
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      const [a, b] = rangePart.split("-");
      const parsedLo = parseInt10(a, "cron range start");
      if (!parsedLo.ok) return parsedLo;
      lo = parsedLo.value;
      if (b !== undefined) {
        const parsedHi = parseInt10(b, "cron range end");
        if (!parsedHi.ok) return parsedHi;
        hi = parsedHi.value;
      } else {
        hi = lo;
      }
    } else if (rangePart === "") {
      return cronError("empty cron range");
    }
    // Bound the range to the field's valid domain, and reject a reversed range,
    // so the loop is always finite and small.
    if (lo < min || hi > max) {
      return cronError(`cron value out of range [${min}, ${max}]: ${lo}-${hi}`);
    }
    if (lo > hi) return cronError(`cron range is reversed: ${lo}-${hi}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return ok(out);
};

const parseCron = (
  cron: string,
): ParseResult<{
  readonly minutes: Set<number>;
  readonly hours: Set<number>;
  readonly doms: Set<number>;
  readonly mons: Set<number>;
  readonly dows: Set<number>;
}> => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return cronError(`cron must have 5 fields, got ${parts.length}: "${cron}"`);
  }
  const [min, hour, dom, mon, dow] = parts;
  const minutes = parseField(min, 0, 59);
  if (!minutes.ok) return minutes;
  const hours = parseField(hour, 0, 23);
  if (!hours.ok) return hours;
  const doms = parseField(dom, 1, 31);
  if (!doms.ok) return doms;
  const mons = parseField(mon, 1, 12);
  if (!mons.ok) return mons;
  const dows = parseField(dow, 0, 6);
  if (!dows.ok) return dows;
  return ok({
    minutes: minutes.value,
    hours: hours.value,
    doms: doms.value,
    mons: mons.value,
    dows: dows.value,
  });
};

/** Validate a 5-field cron expression by parsing every field. Throws `CronError`
 *  on anything malformed (bad field count, step < 1, out-of-range, reversed
 *  range). Returns nothing; used at PUBLISH time to reject adversarial crons and
 *  as the shared validator the matcher builds on. */
export const validateCron = (cron: string): void => {
  const parsed = parseCron(cron);
  if (!parsed.ok) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: validateCron's public contract throws CronError
    throw parsed.error;
  }
};

/** True if `date` (UTC) matches the 5-field cron expression. Defensive: an
 *  invalid cron never matches (and never hangs) rather than throwing into the
 *  tick loop — publish-time validation is the place a bad cron is rejected. */
export const cronMatches = (cron: string, date: Date): boolean => {
  const parsed = parseCron(cron);
  if (!parsed.ok) return false;
  const { minutes, hours, doms, mons, dows } = parsed.value;
  return (
    minutes.has(date.getUTCMinutes()) &&
    hours.has(date.getUTCHours()) &&
    doms.has(date.getUTCDate()) &&
    mons.has(date.getUTCMonth() + 1) &&
    dows.has(date.getUTCDay())
  );
};

export interface SchedulerOptions {
  readonly runtime: AppsRuntime;
  /** The scopes to schedule (self-host single-tenant: one scope). */
  readonly scopes: readonly string[];
  /** Tick interval ms (default 60_000 — cron granularity is one minute). */
  readonly intervalMs?: number;
  /** Injected clock for tests. */
  readonly now?: () => Date;
}

export interface Scheduler {
  /** Run one scheduler tick: fire any due schedules for the given minute. */
  readonly tick: (at?: Date) => Effect.Effect<readonly string[]>;
  readonly start: () => void;
  readonly stop: () => void;
}

export const makeScheduler = (options: SchedulerOptions): Scheduler => {
  const runtime = options.runtime;
  const now = options.now ?? (() => new Date());
  // Dedupe key: `${scope}:${workflow}:${yyyy-mm-ddThh:mm}` so a schedule fires
  // at most once per matching minute even across overlapping ticks.
  const fired = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const minuteKey = (date: Date) => date.toISOString().slice(0, 16);

  const tick = (at: Date = now()): Effect.Effect<readonly string[]> =>
    Effect.gen(function* () {
      const started: string[] = [];
      for (const scope of options.scopes) {
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) continue;
        for (const wf of descriptor.workflows) {
          if (!wf.schedule) continue;
          if (!cronMatches(wf.schedule.cron, at)) continue;
          const key = `${scope}:${wf.name}:${minuteKey(at)}`;
          if (fired.has(key)) continue;
          fired.add(key);
          const runId = `sched-${scope}-${wf.name}-${minuteKey(at)}`;
          yield* runtime
            .startWorkflow({ scope, workflow: wf.name, input: {}, runId })
            .pipe(Effect.orElseSucceed(() => undefined));
          started.push(runId);
        }
      }
      return started as readonly string[];
    });

  return {
    tick,
    start: () => {
      if (timer) return;
      timer = setInterval(() => void Effect.runPromise(tick()), options.intervalMs ?? 60_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
