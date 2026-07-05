import { Effect } from "effect";

import { makeSelfHostApps, BindingError, type ClientResolver } from "@executor-js/plugin-apps/api";

import { resolveDataDir } from "./config";

// ---------------------------------------------------------------------------
// Self-host wiring for the apps subsystem.
//
// The apps subsystem (packages/plugins/apps) owns custom tools, durable
// workflows, ui views and skills behind five substrate-neutral seams. This
// module builds it over the self-hosted backings rooted at the data dir and
// exposes the HTTP surface + close hook that app.ts mounts.
//
// The `ClientResolver` is the one seam that reaches real integrations (the
// platform invoke path: credentials, policy, audit). Wiring it through the
// executor catalog requires per-request executor context that the boot-time
// plugin construction does not hold, so the running self-host server ships a
// resolver that fails with a typed NotImplemented for undeclared external
// calls. The full real path (routing a bound github client to a live API) is
// exercised end-to-end in the apps package e2e against the emulate GitHub. The
// scope-database path (`db.sql`) is fully live in the running server.
// ---------------------------------------------------------------------------

const SELF_HOST_SCOPE = "default";

const notImplementedResolver: ClientResolver = {
  call: ({ integration }) =>
    Effect.fail(
      new BindingError({
        message:
          `external integration "${integration}" routing is not wired into the running self-host ` +
          `server yet (the ClientResolver -> catalog bridge needs per-request executor context). ` +
          `Scope-database tools work; see the apps package e2e for the full external-call path.`,
        role: integration,
        surface: integration,
      }),
    ),
};

export const makeSelfHostAppsSubsystem = () =>
  makeSelfHostApps({
    dataDir: resolveDataDir(),
    resolver: notImplementedResolver,
    scope: SELF_HOST_SCOPE,
  });
