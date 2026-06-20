/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: one-off production migration script over raw postgres plus wrangler subprocess */
// ---------------------------------------------------------------------------
// One-off companion migration for Google Discovery ownership.
//
// The SQL migration moves catalog rows, operation storage, and Postgres-backed
// blobs. Cloud production stores plugin blobs in R2, so the Google spec blobs
// must be copied there too:
//
//   o:<tenant>/openapi/spec/<hash> -> o:<tenant>/google/spec/<hash>
//
// Run before or after the SQL migration. It finds both openapi and google rows
// with Google Discovery config, so it remains useful if the SQL migration has
// already changed plugin_id.
//
//   bun run db:migrate-google-openapi-blobs:prod -- --dry-run
//   bun run db:migrate-google-openapi-blobs:prod
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import postgres from "postgres";

const args = process.argv.slice(2);
const hasArg = (name: string): boolean => args.includes(name);
const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = hasArg("--dry-run");
const bucket = argValue("--bucket");
const limitRaw = argValue("--limit");
const limit = limitRaw ? Number(limitRaw) : Number.POSITIVE_INFINITY;

if (!bucket) {
  console.error("--bucket is required, for example --bucket executor-cloud-blobs");
  process.exit(1);
}
if (!Number.isFinite(limit) && limitRaw) {
  console.error("--limit must be a number");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });
const tempDir = mkdtempSync(join(tmpdir(), "google-openapi-blobs-"));

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const objectPath = (key: string): string => `${bucket}/${key}`;
const wranglerArgs = (command: "get" | "put", key: string, file: string): readonly string[] =>
  command === "get"
    ? ["r2", "object", "get", objectPath(key), "--file", file, "--remote"]
    : ["r2", "object", "put", objectPath(key), "--file", file, "--remote", "--force"];

const objectExists = (key: string): boolean => {
  const file = join(tempDir, `exists-${sha256Hex(key)}`);
  const result = spawnSync("wrangler", wranglerArgs("get", key, file), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
};

const getObject = (key: string, file: string): void => {
  execFileSync("wrangler", wranglerArgs("get", key, file), {
    stdio: ["ignore", "ignore", "inherit"],
  });
};

const putObject = (key: string, file: string): void => {
  execFileSync("wrangler", wranglerArgs("put", key, file), {
    stdio: ["ignore", "ignore", "inherit"],
  });
};

const blobKey = (tenant: string, pluginId: "openapi" | "google", specHash: string): string =>
  `o:${tenant}/${pluginId}/spec/${specHash}`;

try {
  const rows = await sql<{ tenant: string; slug: string; plugin_id: string; spec_hash: string }[]>`
    SELECT
      tenant,
      slug,
      plugin_id,
      config::jsonb ->> 'specHash' AS spec_hash
    FROM integration
    WHERE plugin_id IN ('openapi', 'google')
      AND config IS NOT NULL
      AND jsonb_typeof(config::jsonb -> 'googleDiscoveryUrls') = 'array'
      AND coalesce(config::jsonb ->> 'specHash', '') <> ''
    ORDER BY tenant, slug
  `;

  const work = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
  console.log(`${rows.length} Google Discovery integration row(s) with specHash`);
  if (work.length < rows.length) console.log(`--limit: checking first ${work.length}`);

  let sourcesPresent = 0;
  let targetsPresent = 0;
  let copied = 0;
  const missingSources: string[] = [];
  const conflictingTargets: string[] = [];

  for (const [index, row] of work.entries()) {
    const sourceKey = blobKey(row.tenant, "openapi", row.spec_hash);
    const targetKey = blobKey(row.tenant, "google", row.spec_hash);

    if (dryRun) {
      if (objectExists(sourceKey)) sourcesPresent += 1;
      else missingSources.push(`${row.tenant}/${row.slug}`);
      if (objectExists(targetKey)) targetsPresent += 1;
      continue;
    }

    const sourceFile = join(tempDir, `source-${index}`);
    const targetFile = join(tempDir, `target-${index}`);
    const verifyFile = join(tempDir, `verify-${index}`);

    try {
      getObject(sourceKey, sourceFile);
    } catch {
      missingSources.push(`${row.tenant}/${row.slug}`);
      continue;
    }

    const sourceHash = sha256Hex(readFileSync(sourceFile, "utf8"));
    if (objectExists(targetKey)) {
      getObject(targetKey, targetFile);
      const targetHash = sha256Hex(readFileSync(targetFile, "utf8"));
      if (targetHash === sourceHash) {
        targetsPresent += 1;
        continue;
      }
      conflictingTargets.push(`${row.tenant}/${row.slug}`);
      continue;
    }

    putObject(targetKey, sourceFile);
    getObject(targetKey, verifyFile);
    const verifyHash = sha256Hex(readFileSync(verifyFile, "utf8"));
    if (verifyHash !== sourceHash) {
      throw new Error(`R2 round-trip mismatch for ${targetKey}`);
    }
    copied += 1;
  }

  if (dryRun) {
    console.log(`${sourcesPresent}/${work.length} source R2 object(s) present`);
    console.log(`${targetsPresent}/${work.length} target R2 object(s) already present`);
    console.log(`dry run: would copy ${Math.max(sourcesPresent - targetsPresent, 0)} object(s)`);
  } else {
    console.log(`copied ${copied} object(s)`);
    console.log(`${targetsPresent} target object(s) already present`);
  }

  if (missingSources.length > 0) {
    console.error(`${missingSources.length} source object(s) missing:`);
    for (const entry of missingSources) console.error(`  ${entry}`);
  }
  if (conflictingTargets.length > 0) {
    console.error(
      `${conflictingTargets.length} target object(s) already exist with different content:`,
    );
    for (const entry of conflictingTargets) console.error(`  ${entry}`);
  }
  if (missingSources.length > 0 || conflictingTargets.length > 0) process.exit(1);
} finally {
  await sql.end();
  rmSync(tempDir, { recursive: true, force: true });
}
