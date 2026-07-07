/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: out-of-band deploy-promotion CLI */

/**
 * Promote the LATEST uploaded executor-cloud Worker version to a chosen
 * percentage of live traffic, using Cloudflare's staged gradual-deployment
 * model (`wrangler versions deploy`).
 *
 * This is the second half of the upload -> staged-promotion deploy flow
 * (see apps/cloud/DEPLOY.md and .github/workflows/deploy.yml). Merges upload a
 * version but route no traffic to it; this script promotes it deliberately.
 *
 * Behaviour:
 *   --percent 100   promote the latest uploaded version to 100% (full cutover).
 *   --percent 10    split traffic 10% latest / 90% current-live version, for a
 *                   canary step. Re-run at a higher percentage to advance the
 *                   rollout; the DOs whose sessions land on the newly promoted
 *                   version restart, so keep early steps small and watch
 *                   telemetry between steps.
 *
 * IMPORTANT: a promotion that changes a Durable Object's assigned version
 * restarts that DO (validated empirically, DEPLOY.md experiments 3b/5). Stage
 * promotions to bound that blast radius.
 *
 * Reads no secrets beyond CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (already
 * in the CI env). Config is the generated dist config the build produced.
 */
import { spawnSync } from "node:child_process";

// The generated dist config the build produced. Overridable via
// PROMOTE_CLOUD_CONFIG for local/lab testing against a non-prod worker.
const CONFIG = process.env.PROMOTE_CLOUD_CONFIG ?? "dist/server/wrangler.json";

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const percentRaw = argValue("--percent");
if (!percentRaw) {
  throw new Error("--percent is required (1-100)");
}
const percent = Number(percentRaw);
if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
  throw new Error(`--percent must be an integer 1-100, got: ${percentRaw}`);
}

const wrangler = (wranglerArgs: readonly string[]): string => {
  const result = spawnSync("bun", ["run", "wrangler", ...wranglerArgs], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${wranglerArgs.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
};

type VersionListEntry = {
  readonly id: string;
  readonly number: number;
  readonly metadata?: { readonly created_on?: string };
};
type DeploymentStatus = {
  readonly versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>;
};

// `versions list --json` order is not guaranteed, so sort explicitly by
// version number (monotonic per upload) descending to get the newest.
const versions = JSON.parse(
  wrangler(["versions", "list", "-c", CONFIG, "--json"]),
) as VersionListEntry[];
if (versions.length === 0) {
  throw new Error("no uploaded versions found");
}
const sorted = [...versions].sort((a, b) => {
  if (a.number !== b.number) return b.number - a.number;
  const at = a.metadata?.created_on ?? "";
  const bt = b.metadata?.created_on ?? "";
  return bt.localeCompare(at);
});
const latest = sorted[0];

// The version(s) currently serving live traffic, so a partial promotion holds
// the remainder on the current-live version rather than an arbitrary one.
const status = JSON.parse(
  wrangler(["deployments", "status", "-c", CONFIG, "--json"]),
) as DeploymentStatus;
// The version to hold the remainder of a partial promotion: the current-live
// version carrying the most traffic that is NOT the one we are promoting. If
// the only current version IS the latest, there is nothing to split against.
const currentLive = [...status.versions]
  .filter((v) => v.version_id !== latest.id)
  .sort((a, b) => b.percentage - a.percentage)[0]?.version_id;

if (latest.id === currentLive && percent === 100) {
  console.log(`Latest version ${latest.id} is already live at 100%; nothing to promote.`);
  process.exit(0);
}

const deployArgs = ["versions", "deploy", "-c", CONFIG, "--yes"];
if (percent === 100 || !currentLive || currentLive === latest.id) {
  deployArgs.push(`${latest.id}@100%`);
} else {
  // Staged split: latest@percent, current-live@remainder.
  deployArgs.push(`${latest.id}@${percent}%`, `${currentLive}@${100 - percent}%`);
}

console.log(`Promoting ${latest.id} (version #${latest.number}) at ${percent}%...`);
console.log(wrangler(deployArgs));
console.log("Done. Monitor telemetry, then re-run at a higher percentage to advance the rollout.");
