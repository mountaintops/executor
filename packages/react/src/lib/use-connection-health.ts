// Shared stale-while-revalidate health probing for connections. Two surfaces
// render a connection's health (the detail page's AccountRow and the
// integrations-list summary), and both must revalidate the same way: render
// the persisted `lastHealth` verdict instantly, then probe in the background
// unless the verdict is healthy and fresh. Keeping the guard, the `ifStaleMs`
// semantics, and the freshness window here means the two surfaces cannot
// drift apart.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type { Connection, HealthCheckResult, HealthStatus } from "@executor-js/sdk/shared";

import { checkConnectionHealth } from "../api/atoms";

/** Freshness window for automatic revalidation: a HEALTHY verdict younger
 *  than this renders as-is; anything else (stale, missing, or non-healthy)
 *  triggers a background probe on mount. Server-enforced for the healthy
 *  path too, so concurrent tabs collapse to one probe. */
export const HEALTH_REVALIDATE_MS = 5 * 60 * 1000;

const connectionParams = (connection: Connection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
});

/** Whether a persisted verdict may render as-is without a background probe.
 *  Healthy-and-fresh renders untouched. Everything else revalidates: stale or
 *  never-checked for obvious reasons, and NON-healthy always; an expired dot
 *  is exactly the verdict the user is waiting to see change, so recovery must
 *  show on the next load, not after the freshness window. */
const healthyAndFresh = (last: HealthCheckResult | null | undefined): boolean =>
  last?.status === "healthy" && Date.now() - last.checkedAt < HEALTH_REVALIDATE_MS;

/** The revalidation query: a healthy (but stale) verdict defers to the
 *  server-enforced window so N open tabs can't stampede the upstream; a
 *  missing or non-healthy verdict forces a fresh probe. */
const revalidateQuery = (
  last: HealthCheckResult | null | undefined,
): { readonly ifStaleMs?: number } =>
  last?.status === "healthy" ? { ifStaleMs: HEALTH_REVALIDATE_MS } : {};

/**
 * Health for ONE connection, stale-while-revalidate. The persisted verdict
 * renders instantly; a background probe on mount corrects it in place (once
 * per mount, quiet on failure: the persisted verdict is still the best known
 * state). `runCheck` is the manual path ("Check now"): it always forces a
 * fresh probe and folds the result into the same live state.
 */
export function useConnectionHealth(connection: Connection): {
  readonly probe: HealthCheckResult | null;
  readonly status: HealthStatus;
  readonly runCheck: () => Promise<Exit.Exit<HealthCheckResult, unknown>>;
} {
  // A live probe result, once a check has run, overrides the persisted one.
  const [liveProbe, setLiveProbe] = useState<HealthCheckResult | null>(null);
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });

  const probe = liveProbe ?? connection.lastHealth ?? null;
  const status: HealthStatus = probe?.status ?? "unknown";

  // Health checks are AUTOMATIC: loading the list revalidates any verdict
  // older than the freshness window (or never checked), stale-while-revalidate
  // style: the persisted verdict renders instantly, the probe corrects it in
  // place.
  const revalidated = useRef(false);
  useEffect(() => {
    if (revalidated.current) return;
    const last = connection.lastHealth;
    if (healthyAndFresh(last)) return;
    revalidated.current = true;
    void doCheck({
      params: connectionParams(connection),
      query: revalidateQuery(last),
    }).then((exit) => {
      // Background refresh: update the dot on success, stay quiet on failure
      // (the persisted verdict is still the best known state).
      if (Exit.isSuccess(exit)) setLiveProbe(exit.value);
    });
  }, [connection, doCheck]);

  const runCheck = useCallback(async () => {
    const exit = await doCheck({
      params: connectionParams(connection),
      query: {},
    });
    if (Exit.isSuccess(exit)) setLiveProbe(exit.value);
    return exit;
  }, [connection, doCheck]);

  return { probe, status, runCheck };
}

const probeKey = (connection: Connection): string =>
  `${connection.owner}:${connection.integration}:${connection.name}`;

/**
 * Health for MANY connections at once (the integrations-list summary), where
 * hooks-in-a-loop is illegal. One effect walks the list and fires the same
 * guarded per-connection revalidation as `useConnectionHealth`, accumulating
 * live probes in a map keyed by `owner:integration:name`. The returned reader
 * resolves a connection's best-known probe: the live result when a check has
 * run, otherwise the persisted verdict.
 */
export function useConnectionsHealth(
  connections: readonly Connection[],
): (connection: Connection) => HealthCheckResult | null {
  const [liveProbes, setLiveProbes] = useState<ReadonlyMap<string, HealthCheckResult>>(new Map());
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });

  // Once per mount PER CONNECTION: the list streams in asynchronously, so the
  // effect re-runs as rows arrive; the key set keeps each row to one probe.
  const revalidated = useRef(new Set<string>());
  useEffect(() => {
    for (const connection of connections) {
      const key = probeKey(connection);
      if (revalidated.current.has(key)) continue;
      const last = connection.lastHealth;
      if (healthyAndFresh(last)) continue;
      revalidated.current.add(key);
      void doCheck({
        params: connectionParams(connection),
        query: revalidateQuery(last),
      }).then((exit) => {
        if (Exit.isSuccess(exit)) {
          setLiveProbes((current) => new Map(current).set(key, exit.value));
        }
      });
    }
  }, [connections, doCheck]);

  return useCallback(
    (connection: Connection) =>
      liveProbes.get(probeKey(connection)) ?? connection.lastHealth ?? null,
    [liveProbes],
  );
}
