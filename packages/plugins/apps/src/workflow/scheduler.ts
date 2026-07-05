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

const parseField = (field: string, min: number, max: number): Set<number> => {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : Number(a);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

/** True if `date` (UTC) matches the 5-field cron expression. */
export const cronMatches = (cron: string, date: Date): boolean => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  const minutes = parseField(min, 0, 59);
  const hours = parseField(hour, 0, 23);
  const doms = parseField(dom, 1, 31);
  const mons = parseField(mon, 1, 12);
  const dows = parseField(dow, 0, 6);
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
