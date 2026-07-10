import { useCallback, useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  PolicyId,
  positionForNewPattern,
  type Owner,
  type ToolPolicyAction,
} from "@executor-js/sdk/shared";

import {
  createPolicyOptimistic,
  policiesOptimisticAtom,
  removePolicyOptimistic,
  updatePolicyOptimistic,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";

export interface PolicyAction {
  /** Set the action on a pattern. If a user rule with this exact pattern
   *  already exists, update it. Otherwise create with auto-placed
   *  position so more-specific rules keep precedence. */
  readonly set: (pattern: string, action: ToolPolicyAction) => Promise<void>;
  /** Remove the user rule with this exact pattern, if any. No-op if none. */
  readonly clear: (pattern: string) => Promise<void>;
  /** True while a write is in flight. */
  readonly busy: boolean;
}

/**
 * Policy write actions, scoped to an explicit `owner` (Personal vs Workspace).
 *
 * The global owner toggle is retired, so this hook no longer reads an ambient
 * owner. Owner is a REAL partition for policy writes (`byOwner(input.owner)` on
 * the server), so the caller chooses it explicitly. It defaults to `"org"`
 * (Workspace) — the same value the old `DEFAULT_OWNER` produced — so existing
 * policy behavior is preserved exactly. The hook filters exact-match candidates
 * to this owner and writes create/update/remove against it.
 */
export const usePolicyActions = (owner: Owner = "org"): PolicyAction => {
  const policies = useAtomValue(policiesOptimisticAtom);
  const doCreate = useAtomSet(createPolicyOptimistic, { mode: "promise" });
  const doUpdate = useAtomSet(updatePolicyOptimistic, { mode: "promise" });
  const doRemove = useAtomSet(removePolicyOptimistic, { mode: "promise" });

  // Sorted by position ASC (lowest position = highest precedence first),
  // matching server evaluation order. Optimistic placeholder rows carry
  // `position: ""` and sort to the very top — that's fine for lookup but
  // they're skipped when computing insert position. Only this owner's rows are
  // candidates for matching an exact pattern we'd update.
  const sorted = useMemo(() => {
    if (!AsyncResult.isSuccess(policies))
      return [] as ReadonlyArray<{
        readonly id: string;
        readonly owner: Owner;
        readonly pattern: string;
        readonly action: ToolPolicyAction;
        readonly position: string;
      }>;
    return [...policies.value]
      .filter((p) => p.owner === owner)
      .sort((a, b) => {
        if (a.position < b.position) return -1;
        if (a.position > b.position) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [policies, owner]);

  const busy = policies.waiting;

  // Specificity-aware placement (below any more-specific rule) via the shared
  // sdk helper — the same computation the server applies when no position is
  // sent. Computing it here too keeps the optimistic UI's final order stable;
  // if this client's list is stale, the server default is the backstop.
  const computePosition = useCallback(
    (newPattern: string): string | undefined => {
      const committed = sorted.filter((r) => r.position !== "");
      if (committed.length === 0) return undefined;
      return positionForNewPattern(newPattern, committed);
    },
    [sorted],
  );

  const findExact = useCallback(
    (pattern: string) => sorted.find((r) => r.pattern === pattern && r.position !== ""),
    [sorted],
  );

  const set = useCallback(
    async (pattern: string, action: ToolPolicyAction) => {
      const patternKind = pattern.endsWith(".*") ? "group" : "exact";
      const existing = findExact(pattern);
      if (existing) {
        if (existing.action === action) return;
        await doUpdate({
          params: { policyId: PolicyId.make(existing.id) },
          payload: { owner, action },
          reactivityKeys: policyWriteKeys,
        });
        trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
        return;
      }
      const position = computePosition(pattern);
      await doCreate({
        payload:
          position === undefined
            ? { owner, pattern, action }
            : { owner, pattern, action, position },
        reactivityKeys: policyWriteKeys,
      });
      trackEvent("tool_policy_set", { action, pattern_kind: patternKind, owner });
    },
    [owner, doCreate, doUpdate, findExact, computePosition],
  );

  const clear = useCallback(
    async (pattern: string) => {
      const existing = findExact(pattern);
      if (!existing) return;
      await doRemove({
        params: { policyId: PolicyId.make(existing.id) },
        payload: { owner },
        reactivityKeys: policyWriteKeys,
      });
      trackEvent("tool_policy_cleared", {
        pattern_kind: pattern.endsWith(".*") ? "group" : "exact",
        owner,
      });
    },
    [owner, doRemove, findExact],
  );

  return { set, clear, busy };
};
