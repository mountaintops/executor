import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeSelfHostAppsRuntime } from "../plugin/self-host-runtime";
import { makeInMemoryAppsStore, makeTestResolver, dailyBriefFileSet } from "../testing";
import { cronMatches, makeScheduler } from "./scheduler";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("scheduler", () => {
  it("matches cron fields (minute hour dom mon dow)", () => {
    // "0 9 * * 1-5" -> weekdays at 09:00 UTC.
    const weekdayNine = new Date(Date.UTC(2026, 0, 5, 9, 0, 0)); // Mon 2026-01-05
    expect(cronMatches("0 9 * * 1-5", weekdayNine)).toBe(true);
    const weekendNine = new Date(Date.UTC(2026, 0, 4, 9, 0, 0)); // Sun
    expect(cronMatches("0 9 * * 1-5", weekendNine)).toBe(false);
    const weekdayTen = new Date(Date.UTC(2026, 0, 5, 10, 0, 0));
    expect(cronMatches("0 9 * * 1-5", weekdayTen)).toBe(false);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 3, 30, 0)))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 3, 31, 0)))).toBe(false);
  });

  it("fires a due workflow schedule and starts the run", async () => {
    const store = makeInMemoryAppsStore();
    const resolver = makeTestResolver({
      github: {
        "repos.listForAuthenticatedUser": () => [{ full_name: "acme/app" }],
        "issues.listForRepo": () => [],
      },
    });
    const host = makeSelfHostAppsRuntime({
      dataDir: mkdtempSync(join(tmpdir(), "apps-sched-")),
      store,
      resolver,
      inMemory: true,
    });
    await run(host.runtime.publish({ scope: "rhys", files: dailyBriefFileSet() }));

    const scheduler = makeScheduler({ runtime: host.runtime, scopes: ["rhys"] });
    // morning-sync is "0 9 * * 1-5". Tick at a matching minute.
    const at = new Date(Date.UTC(2026, 0, 5, 9, 0, 0));
    const started = await run(scheduler.tick(at));
    expect(started.length).toBe(1);

    const run1 = await run(host.runtime.getRun(started[0]));
    expect(run1?.workflow).toBe("morning-sync");
    expect(run1?.status).toBe("completed");

    // A second tick in the same minute does not double-fire.
    const again = await run(scheduler.tick(at));
    expect(again.length).toBe(0);

    await host.close();
  });
});
