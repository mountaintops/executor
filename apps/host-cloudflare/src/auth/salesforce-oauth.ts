import { Config } from "../config";

interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
}

interface SfApiKeyRecord {
  api_key: string;
  instance_url: string;
  access_token: string;
  refresh_token: string;
  client_id: string;
  created_at: number;
}

// Global in-memory cache fallback if D1 is unavailable
const memoryApiKeyStore = new Map<string, SfApiKeyRecord>();
const memoryOpenApiSpecCache = new Map<string, { json: string; etag: string; timestamp: number }>();

let d1TablesInitialized = false;
async function ensureD1Tables(db: D1Database): Promise<void> {
  if (d1TablesInitialized) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sf_api_keys (
        api_key TEXT PRIMARY KEY,
        instance_url TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sf_openapi_cache (
        instance_url TEXT PRIMARY KEY,
        etag TEXT NOT NULL DEFAULT '',
        locator_id TEXT,
        r2_key TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sf_execution_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        summary TEXT NOT NULL,
        r2_key TEXT
      )
    `).run();
    // Migrations for existing DBs
    for (const col of ['locator_id TEXT', 'r2_key TEXT']) {
      try { await db.prepare(`ALTER TABLE sf_openapi_cache ADD COLUMN ${col}`).run(); } catch (_) {}
    }
    d1TablesInitialized = true;
  } catch (e) {
    console.error("ensureD1Tables error:", e);
  }
}

export interface ExecutionLogRecord {
  id: string;
  timestamp: string;
  expires_at: number;
  event: string;
  summary: string;
  payload: any;
}

const memoryLogStore = new Map<string, ExecutionLogRecord>();

async function saveExecutionLog(
  env: any,
  logId: string,
  event: string,
  summary: string,
  payload: any
): Promise<string> {
  const now = Date.now();
  const expiresAt = now + 3600 * 1000; // 1 hour TTL
  const logRecord: ExecutionLogRecord = {
    id: logId,
    timestamp: new Date(now).toISOString(),
    expires_at: expiresAt,
    event,
    summary,
    payload,
  };

  memoryLogStore.set(logId, logRecord);

  const payloadStr = JSON.stringify(logRecord, null, 2);
  let r2Key: string | null = null;

  if (env && env.BLOBS) {
    try {
      r2Key = `logs/${logId}.json`;
      await env.BLOBS.put(r2Key, payloadStr, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { expiresAt: expiresAt.toString() }
      });
    } catch (r2Err) {
      console.error("R2 log save error:", r2Err);
    }
  }

  if (env && env.DB) {
    try {
      await ensureD1Tables(env.DB);
      await env.DB.prepare(`
        INSERT OR REPLACE INTO sf_execution_logs (id, timestamp, expires_at, event, summary, r2_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(logId, logRecord.timestamp, expiresAt, event, summary, r2Key || "").run();
    } catch (d1Err) {
      console.error("D1 log metadata save error:", d1Err);
    }
  }

  return logId;
}

async function getExecutionLog(env: any, logId: string): Promise<ExecutionLogRecord | null> {
  const now = Date.now();

  const mem = memoryLogStore.get(logId);
  if (mem) {
    if (now > mem.expires_at) {
      memoryLogStore.delete(logId);
      return null;
    }
    return mem;
  }

  if (env && env.DB) {
    try {
      await ensureD1Tables(env.DB);
      const row = await env.DB.prepare(`
        SELECT id, timestamp, expires_at, event, summary, r2_key FROM sf_execution_logs WHERE id = ?
      `).bind(logId).first();

      if (row) {
        const expiresAt = row.expires_at as number;
        if (now > expiresAt) {
          try {
            await env.DB.prepare("DELETE FROM sf_execution_logs WHERE id = ?").bind(logId).run();
            if (env.BLOBS && row.r2_key) {
              await env.BLOBS.delete(row.r2_key as string);
            }
          } catch (_) {}
          return null;
        }

        if (env.BLOBS && row.r2_key) {
          const r2Obj = await env.BLOBS.get(row.r2_key as string);
          if (r2Obj) {
            const text = await r2Obj.text();
            return JSON.parse(text);
          }
        }
      }
    } catch (dbErr) {
      console.error("D1 getExecutionLog error:", dbErr);
    }
  }

  return null;
}

/** Store a large spec in R2 and return the R2 key used */
async function saveSpecToR2(env: any, instanceUrl: string, specJson: string): Promise<string | null> {
  if (!env.BLOBS) return null;
  try {
    const encoder = new TextEncoder();
    const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(instanceUrl));
    const urlHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
    const r2Key = `sf-oas3/${urlHash}/spec.json`;
    await env.BLOBS.put(r2Key, specJson, { httpMetadata: { contentType: "application/json" } });
    return r2Key;
  } catch (err) {
    console.error("R2 save error:", err);
    return null;
  }
}

/** Retrieve a spec from R2 by key */
async function loadSpecFromR2(env: any, r2Key: string): Promise<string | null> {
  if (!env.BLOBS || !r2Key) return null;
  try {
    const obj = await env.BLOBS.get(r2Key);
    if (!obj) return null;
    return await obj.text();
  } catch (err) {
    console.error("R2 load error:", err);
    return null;
  }
}

async function getApiKeyRecord(env: any, apiKey: string): Promise<SfApiKeyRecord | null> {
  const cleanKey = apiKey ? apiKey.replace(/[,.\s]+$/, "").trim() : "";
  if (env && env.DB) {
    try {
      await ensureD1Tables(env.DB);
      let row: any = null;
      if (cleanKey) {
        row = await env.DB.prepare(
          "SELECT api_key, instance_url, access_token, refresh_token, client_id, created_at FROM sf_api_keys WHERE TRIM(api_key) = TRIM(?)"
        ).bind(cleanKey).first();
      }

      if (!row) {
        row = await env.DB.prepare(
          "SELECT api_key, instance_url, access_token, refresh_token, client_id, created_at FROM sf_api_keys ORDER BY created_at DESC LIMIT 1"
        ).first();
      }

      if (row) {
        return {
          api_key: row.api_key as string,
          instance_url: row.instance_url as string,
          access_token: row.access_token as string,
          refresh_token: (row.refresh_token as string) || "",
          client_id: row.client_id as string,
          created_at: row.created_at as number,
        };
      }
    } catch (err) {
      console.error("D1 lookup error:", err);
    }
  }
  return (cleanKey ? memoryApiKeyStore.get(cleanKey) : null) || Array.from(memoryApiKeyStore.values())[0] || null;
}

async function updateApiKeyRecordTokens(env: any, apiKey: string, accessToken: string, refreshToken?: string): Promise<void> {
  if (env.DB) {
    try {
      if (refreshToken) {
        await env.DB.prepare(
          "UPDATE sf_api_keys SET access_token = ?, refresh_token = ? WHERE api_key = ?"
        ).bind(accessToken, refreshToken, apiKey).run();
      } else {
        await env.DB.prepare(
          "UPDATE sf_api_keys SET access_token = ? WHERE api_key = ?"
        ).bind(accessToken, apiKey).run();
      }
    } catch (err) {
      console.error("D1 update error:", err);
    }
  }
  const mem = memoryApiKeyStore.get(apiKey);
  if (mem) {
    mem.access_token = accessToken;
    if (refreshToken) mem.refresh_token = refreshToken;
  }
}

/**
 * Execute a request to Salesforce, automatically refreshing the access token if 401 Unauthorized occurs.
 */
async function executeSfRequest(
  env: any,
  record: SfApiKeyRecord,
  endpointPath: string,
  method: string,
  body?: string
): Promise<Response> {
  const sfUrl = `${record.instance_url}${endpointPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${record.access_token}`,
    "X-SFDC-Session": record.access_token,
    "Accept": "application/json",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  let sfRes = await fetch(sfUrl, { method, headers, body });

  // If token expired (401), attempt auto-refresh using refresh_token
  if (sfRes.status === 401 && record.refresh_token && record.client_id) {
    console.log("Salesforce token expired (401). Attempting automatic refresh...");
    try {
      const tokenEndpoint = `${record.instance_url}/services/oauth2/token`;
      const bodyParams = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: record.client_id,
        refresh_token: record.refresh_token,
      });

      const refreshRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: bodyParams.toString(),
      });

      if (refreshRes.ok) {
        const refreshData = (await refreshRes.json()) as { access_token: string; refresh_token?: string };
        record.access_token = refreshData.access_token;
        if (refreshData.refresh_token) {
          record.refresh_token = refreshData.refresh_token;
        }

        await updateApiKeyRecordTokens(env, record.api_key, record.access_token, record.refresh_token);

        headers["Authorization"] = `Bearer ${record.access_token}`;
        headers["X-SFDC-Session"] = record.access_token;

        sfRes = await fetch(sfUrl, { method, headers, body });
      }
    } catch (refreshErr) {
      console.error("Token auto-refresh failed:", refreshErr);
    }
  }

  return sfRes;
}

/**
 * Validate that the string is a valid OpenAPI 3.0 spec JSON and NOT an error response (such as INVALID_SESSION_ID)
 */
function isValidOpenApiSpec(specJson: string | null | undefined): boolean {
  if (!specJson || typeof specJson !== "string") return false;
  const lower = specJson.toLowerCase();

  // Guard against Salesforce XML / JSON session & authentication errors
  if (
    lower.includes("invalid_session_id") ||
    lower.includes("session expired or invalid") ||
    lower.includes("<errorcode>") ||
    lower.includes('"errorcode"') ||
    lower.includes("unauthorized")
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(specJson);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].errorCode) {
      return false;
    }
    if (parsed.error || parsed.errorCode || (parsed.message && !parsed.info && !parsed.paths)) {
      return false;
    }
    // Must contain valid OpenAPI structural keys
    if (parsed.openapi || parsed.paths || parsed.swagger || parsed.info) {
      return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

/** Compute SHA-256 hash for ETag generation */
async function computeSha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Invalidate cached OpenAPI spec for a given instance URL */
async function invalidateOpenApiCache(env: any, instanceUrl: string): Promise<void> {
  memoryOpenApiSpecCache.delete(instanceUrl);
  if (env.DB) {
    try {
      await ensureD1Tables(env.DB);
      await env.DB.prepare("DELETE FROM sf_openapi_cache WHERE instance_url = ?").bind(instanceUrl).run();
    } catch (err) {
      console.error("D1 cache invalidation error:", err);
    }
  }
}

const SF_API_VERSION = "v67.0";

// Salesforce rate-limits OAS3 generation to once per 6 hours per user.
// We cache for 47h (just under their 48h result TTL).
const SF_OAS3_CACHE_TTL_MS = 47 * 60 * 60 * 1000;
// In-memory short-circuit TTL (5 minutes) so we don't re-read D1 on every request.
const SF_MEM_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Phase 1: Start a Salesforce OAS3 generation job.
 * On v67.0+, Salesforce may complete synchronously — if so, returns the spec JSON directly.
 * Otherwise returns { locatorId } to poll later.
 */
async function startSalesforceOas3Job(
  env: any,
  record: SfApiKeyRecord
): Promise<{ locatorId: string; specJson?: string }> {
  const base = `/services/data/${SF_API_VERSION}/async/specifications/oas3`;
  const startRes = await executeSfRequest(
    env, record, base, "POST",
    JSON.stringify({ resources: ["*"] })
  );
  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Salesforce OAS3 job start failed (${startRes.status}): ${errText}`);
  }
  const startData = (await startRes.json()) as { locator?: string; id?: string; apiTaskStatus?: string; href?: string; resultsHref?: string };
  const locatorId = startData.locator || startData.id;
  if (!locatorId) {
    throw new Error(`No locator returned. Response: ${JSON.stringify(startData)}`);
  }

  // If Salesforce already completed the job (returns href immediately without InProgress),
  // fetch results right now instead of storing a pending locator
  const status = (startData.apiTaskStatus || "").toUpperCase();
  if (status === "COMPLETED" || status === "SUCCESS" || status === "COMPLETE") {
    const resultsHref = startData.resultsHref || `${base}/${locatorId}/results`;
    const resultsRes = await executeSfRequest(env, record, resultsHref, "GET");
    if (!resultsRes.ok) {
      const errText = await resultsRes.text();
      throw new Error(`Salesforce OAS3 results fetch failed immediately (${resultsRes.status}): ${errText}`);
    }
    const specText = await resultsRes.text();
    if (!isValidOpenApiSpec(specText)) {
      throw new Error("Salesforce OAS3 returned invalid spec payload or INVALID_SESSION_ID error.");
    }
    return { locatorId, specJson: specText };
  }

  return { locatorId };
}

/**
 * Phase 2: Check the status of an existing job. Returns null if still in progress,
 * or the spec JSON string if complete.
 */
async function checkSalesforceOas3Job(
  env: any,
  record: SfApiKeyRecord,
  locatorId: string
): Promise<string | null> {
  const base = `/services/data/${SF_API_VERSION}/async/specifications/oas3`;
  const pollRes = await executeSfRequest(env, record, `${base}/${locatorId}`, "GET");
  if (!pollRes.ok) {
    const errText = await pollRes.text();
    throw new Error(`Salesforce OAS3 poll failed (${pollRes.status}): ${errText}`);
  }
  const pollData = (await pollRes.json()) as { apiTaskStatus?: string; status?: string; href?: string; id?: string };
  const status = pollData.apiTaskStatus || pollData.status || "InProgress";
  console.log(`OAS3 status check for locator ${locatorId}: ${status}`);

  // If Salesforce returned {href, id} with no apiTaskStatus, the job is already complete
  if (!pollData.apiTaskStatus && !pollData.status && pollData.href) {
    console.log(`OAS3 job already complete (href present), fetching results...`);
    const resultsRes = await executeSfRequest(env, record, `${base}/${locatorId}/results`, "GET");
    if (!resultsRes.ok) {
      const errText = await resultsRes.text();
      throw new Error(`Salesforce OAS3 results fetch failed (${resultsRes.status}): ${errText}`);
    }
    const specText = await resultsRes.text();
    if (!isValidOpenApiSpec(specText)) {
      throw new Error("Salesforce OAS3 returned invalid spec payload or INVALID_SESSION_ID error.");
    }
    return specText;
  }

  if (status === "InProgress" || status === "New") {
    return null; // Still running
  }

  if (status.toUpperCase() !== "COMPLETED" && status.toUpperCase() !== "SUCCESS" && status.toUpperCase() !== "COMPLETE") {
    throw new Error(`Salesforce OAS3 generation failed with status: ${status}`);
  }

  // Fetch results
  const resultsRes = await executeSfRequest(env, record, `${base}/${locatorId}/results`, "GET");
  if (!resultsRes.ok) {
    const errText = await resultsRes.text();
    throw new Error(`Salesforce OAS3 results fetch failed (${resultsRes.status}): ${errText}`);
  }
  const specText = await resultsRes.text();
  if (!isValidOpenApiSpec(specText)) {
    throw new Error("Salesforce OAS3 returned invalid spec payload or INVALID_SESSION_ID error.");
  }
  return specText;
}

/**
 * Get (or cache-hit) the Salesforce org's real OpenAPI 3.0 spec.
 * Validates spec JSON to prevent caching INVALID_SESSION_ID errors.
 */
async function getOrGenerateOpenApiSpec(
  env: any,
  record: SfApiKeyRecord,
  forceRefresh: boolean = false
): Promise<{ specJson: string; etag: string; cachedHit: boolean }> {
  const instanceUrl = record.instance_url;

  // 1. Check in-memory cache
  if (!forceRefresh) {
    const memCache = memoryOpenApiSpecCache.get(instanceUrl);
    if (memCache && isValidOpenApiSpec(memCache.json) && (Date.now() - memCache.timestamp < SF_MEM_CACHE_TTL_MS)) {
      return { specJson: memCache.json, etag: memCache.etag, cachedHit: true };
    }
  }

  // 2. Check D1 persistent cache (metadata) + R2 (spec body)
  if (!forceRefresh && env.DB) {
    try {
      await ensureD1Tables(env.DB);
      const row = await env.DB.prepare(
        "SELECT etag, updated_at, locator_id, r2_key FROM sf_openapi_cache WHERE instance_url = ?"
      ).bind(instanceUrl).first();

      if (row) {
        const updatedAt = row.updated_at as number;
        const locatorId = row.locator_id as string | null;
        const r2Key = row.r2_key as string | null;
        const etag = row.etag as string;

        // Has a fresh cached spec in R2 — verify and serve it
        if (r2Key && etag && Date.now() - updatedAt < SF_OAS3_CACHE_TTL_MS) {
          const specJson = await loadSpecFromR2(env, r2Key);
          if (specJson && isValidOpenApiSpec(specJson)) {
            memoryOpenApiSpecCache.set(instanceUrl, { json: specJson, etag, timestamp: Date.now() });
            return { specJson, etag, cachedHit: true };
          }
        }

        // Has an in-flight locator — check its status (one fast HTTP call)
        if (locatorId && !r2Key) {
          try {
            const specJson = await checkSalesforceOas3Job(env, record, locatorId);
            if (specJson === null) {
              throw new Error("PENDING: Salesforce OAS3 spec is still being generated. Retry in a few seconds.");
            }
            if (isValidOpenApiSpec(specJson)) {
              // Complete! Save to R2 + update D1 metadata
              const hash = await computeSha256(specJson);
              const etag = `W/"sf_oas3_${hash.substring(0, 16)}"`;
              const now = Date.now();
              const r2Key = await saveSpecToR2(env, instanceUrl, specJson);
              memoryOpenApiSpecCache.set(instanceUrl, { json: specJson, etag, timestamp: now });
              await env.DB.prepare(
                "INSERT OR REPLACE INTO sf_openapi_cache (instance_url, etag, locator_id, r2_key, updated_at) VALUES (?, ?, NULL, ?, ?)"
              ).bind(instanceUrl, etag, r2Key, now).run();
              return { specJson, etag, cachedHit: false };
            }
          } catch (err: any) {
            if ((err.message as string).startsWith("PENDING:")) throw err;
            console.error("Error checking OAS3 job status:", err);
          }
        }
      }
    } catch (err: any) {
      if ((err.message as string).startsWith("PENDING:")) throw err;
      console.error("D1 spec cache lookup error:", err);
    }
  }

  // 3. Start a new generation job
  let locatorId: string;
  let immediateSpec: string | undefined;
  try {
    const result = await startSalesforceOas3Job(env, record);
    locatorId = result.locatorId;
    immediateSpec = result.specJson;
    console.log(`Started Salesforce OAS3 job: ${locatorId}, immediate: ${!!immediateSpec}`);
  } catch (err: any) {
    // Fallback: Try fetching spec directly from package's Apex REST endpoint
    try {
      const packageOpenApiUrl = `${instanceUrl}/services/apexrest/mcp/v1/openapi`;
      const pkgRes = await fetch(packageOpenApiUrl);
      if (pkgRes.ok) {
        const pkgSpec = await pkgRes.text();
        if (isValidOpenApiSpec(pkgSpec)) {
          console.log(`Fetched valid OpenAPI spec from Apex REST endpoint: ${packageOpenApiUrl}`);
          const hash = await computeSha256(pkgSpec);
          const etag = `W/"sf_oas3_${hash.substring(0, 16)}"`;
          const now = Date.now();
          memoryOpenApiSpecCache.set(instanceUrl, { json: pkgSpec, etag, timestamp: now });
          const r2Key = await saveSpecToR2(env, instanceUrl, pkgSpec);
          if (env.DB) {
            await ensureD1Tables(env.DB);
            await env.DB.prepare(
              "INSERT OR REPLACE INTO sf_openapi_cache (instance_url, etag, locator_id, r2_key, updated_at) VALUES (?, ?, NULL, ?, ?)"
            ).bind(instanceUrl, etag, r2Key, now).run();
          }
          return { specJson: pkgSpec, etag, cachedHit: false };
        }
      }
    } catch (_) {}

    // Graceful fallback: serve stale valid cache from R2 if available to prevent INVALID_SESSION_ID errors
    if (env.DB) {
      try {
        const staleRow = await env.DB.prepare(
          "SELECT r2_key, etag FROM sf_openapi_cache WHERE instance_url = ? AND r2_key IS NOT NULL"
        ).bind(instanceUrl).first();
        if (staleRow && staleRow.r2_key) {
          const staleSpec = await loadSpecFromR2(env, staleRow.r2_key as string);
          if (staleSpec && isValidOpenApiSpec(staleSpec)) {
            console.warn("OAS3 job start failed; serving valid cached R2 spec.");
            return { specJson: staleSpec, etag: staleRow.etag as string, cachedHit: true };
          }
        }
      } catch (_) {}
    }
    throw new Error(`Failed to start Salesforce OAS3 job: ${err.message}`);
  }

  // If the job completed synchronously and returned a valid spec, save to R2 + D1 and return immediately
  if (immediateSpec && isValidOpenApiSpec(immediateSpec)) {
    const hash = await computeSha256(immediateSpec);
    const etag = `W/"sf_oas3_${hash.substring(0, 16)}"`;
    const now = Date.now();
    memoryOpenApiSpecCache.set(instanceUrl, { json: immediateSpec, etag, timestamp: now });
    const r2Key = await saveSpecToR2(env, instanceUrl, immediateSpec);
    if (env.DB) {
      try {
        await ensureD1Tables(env.DB);
        await env.DB.prepare(
          "INSERT OR REPLACE INTO sf_openapi_cache (instance_url, etag, locator_id, r2_key, updated_at) VALUES (?, ?, NULL, ?, ?)"
        ).bind(instanceUrl, etag, r2Key, now).run();
      } catch (dbErr) {
        console.error("Failed to save immediate spec metadata to D1:", dbErr);
      }
    }
    return { specJson: immediateSpec, etag, cachedHit: false };
  }

  // Save the locator in D1 so the next request can check status
  if (env.DB) {
    try {
      await ensureD1Tables(env.DB);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sf_openapi_cache (instance_url, etag, locator_id, r2_key, updated_at) VALUES (?, '', ?, NULL, ?)"
      ).bind(instanceUrl, locatorId, Date.now()).run();
    } catch (dbErr) {
      console.error("Failed to save locator to D1:", dbErr);
    }
  }

  throw new Error(`PENDING: Salesforce OAS3 spec generation started (locator: ${locatorId}). Retry in ~10 seconds.`);
}

export function makeSalesforceOAuthHandler(config: Config, env: any) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight for all /api/sf routes
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-SFDC-Session, If-None-Match",
        },
      });
    }

    // -------------------------------------------------------------------------
    // 0. Cached Execution Logs Retrieval Route (/api/sf/logs/:logId or /api/logs/:logId)
    // -------------------------------------------------------------------------
    if ((pathname.includes("/logs/") || pathname.endsWith("/logs")) && request.method === "GET") {
      let logId = "";
      if (pathname.includes("/logs/")) {
        logId = pathname.split("/logs/")[1];
      }
      if (!logId) {
        logId = url.searchParams.get("id") || url.searchParams.get("logId") || "";
      }

      if (!logId) {
        return new Response(
          JSON.stringify({ error: "Missing log ID parameter. Usage: GET /api/sf/logs/<logId>" }),
          { status: 400, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const logEntry = await getExecutionLog(env, logId.trim());
      if (!logEntry) {
        return new Response(
          JSON.stringify({
            error: "Log Not Found or Expired",
            message: `Log with ID '${logId}' was not found or has expired (execution logs are automatically purged 1 hour after creation).`,
            logId: logId.trim()
          }),
          { status: 404, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      return new Response(JSON.stringify(logEntry, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "X-Log-Expires-At": new Date(logEntry.expires_at).toISOString(),
        },
      });
    }

    // -------------------------------------------------------------------------
    // 1. Initiate OAuth Login Route (/api/oauth/sf/login or /api/oauth/sf/authorize)
    // -------------------------------------------------------------------------
    if ((pathname.includes("/sf/login") || pathname.includes("/sf/authorize")) && request.method === "GET") {
      const domain = url.searchParams.get("domain") || "login.salesforce.com";
      const DEFAULT_CLIENT_ID = "3MVG97L7PWbPq6UwRxF9421lWKMABDZvIzl3DO3ZCWVhC.SnVSux.NzBA55Tw0UoVHsTviflTVFUhGhXPDvv.";
      const clientId = url.searchParams.get("client_id") || DEFAULT_CLIENT_ID;
      const redirectUri = "https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/sf/callback";

      // Generate standard RFC 7636 PKCE code verifier and code challenge
      const toBase64Url = (bytes: Uint8Array): string =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=/g, "");

      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);
      const codeVerifier = toBase64Url(randomBytes);

      const encoder = new TextEncoder();
      const verifierData = encoder.encode(codeVerifier);
      const digest = await crypto.subtle.digest("SHA-256", verifierData);
      const codeChallenge = toBase64Url(new Uint8Array(digest));

      const statePayload = btoa(JSON.stringify({ domain, clientId, verifier: codeVerifier }));

      const authParams = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: statePayload,
      });

      const userScope = url.searchParams.get("scope");
      if (userScope) {
        authParams.set("scope", userScope);
      }

      const authUrl = `https://${domain}/services/oauth2/authorize?${authParams.toString()}`;
      return Response.redirect(authUrl, 302);
    }

    // -------------------------------------------------------------------------
    // 1b. Salesforce Auto-Registration Webhook Receiver (/webhook or /api/sf/webhook)
    // -------------------------------------------------------------------------
    if ((pathname.includes("/webhook") || pathname.includes("/sf/webhook")) && request.method === "POST") {
      try {
        const payload = (await request.json()) as {
          event?: string;
          orgId?: string;
          mcpServerUrl?: string;
          restApiUrl?: string;
          openApiSpecUrl?: string;
          openApiSpecJson?: string;
          queryUrl?: string;
          sobjectsUrl?: string;
          clientId?: string;
          clientSecret?: string;
          status?: string;
          installedByUser?: string;
          timestamp?: string;
        };

        const logId = "log_" + crypto.randomUUID().replace(/-/g, "");
        await saveExecutionLog(env, logId, payload.event || "MCP_AUTO_REGISTER_SUCCESS", "Salesforce Auto-Registration Webhook Payload", payload);

        const requestWebOrigin = url.origin;
        const logCurlUrl = `${requestWebOrigin}/api/sf/logs/${logId}`;

        console.log("=================================================");
        console.log("🚀 [executor-cloudflare] Received Salesforce Auto-Registration Webhook:");
        console.log("• Event           :", payload.event || "MCP_AUTO_REGISTER_SUCCESS");
        console.log("• Org ID          :", payload.orgId);
        console.log("• MCP Server URL  :", payload.mcpServerUrl);
        console.log("• REST API URL    :", payload.restApiUrl);
        console.log("• OpenAPI Spec URL:", payload.openApiSpecUrl);
        console.log("• Client ID       :", payload.clientId);
        console.log("• Status          :", payload.status);
        console.log("• Installed User  :", payload.installedByUser);
        console.log("• Log ID (1h TTL) :", logId);
        console.log("• Retrieve via curl:", `curl -s "${logCurlUrl}"`);
        let viewableOpenApiUrl = "";
        if (payload.clientId && payload.mcpServerUrl) {
          const apiKey = "sf_key_" + crypto.randomUUID().replace(/-/g, "");
          const instanceOrigin = payload.mcpServerUrl.startsWith("http")
            ? new URL(payload.mcpServerUrl).origin
            : `https://${payload.mcpServerUrl}`;

          viewableOpenApiUrl = `${requestWebOrigin}/api/sf/openapi.json?api_key=${apiKey}`;

          console.log("• Viewable Cached OpenAPI Spec URL :", viewableOpenApiUrl);
          console.log("=================================================");

          const sfRecord: SfApiKeyRecord = {
            api_key: apiKey,
            instance_url: instanceOrigin,
            access_token: payload.clientSecret || "",
            refresh_token: "",
            client_id: payload.clientId,
            created_at: Date.now(),
          };
          memoryApiKeyStore.set(apiKey, sfRecord);

          if (env.DB) {
            try {
              await ensureD1Tables(env.DB);
              await env.DB.prepare(`
                INSERT OR REPLACE INTO sf_api_keys (api_key, instance_url, access_token, refresh_token, client_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).bind(
                apiKey,
                sfRecord.instance_url,
                sfRecord.access_token,
                "",
                payload.clientId,
                Date.now()
              ).run();
            } catch (dbErr) {
              console.error("D1 save error for webhook:", dbErr);
            }
          }

          // Cache incoming OpenAPI Spec JSON if provided in payload
          if (payload.openApiSpecJson && isValidOpenApiSpec(payload.openApiSpecJson)) {
            try {
              const specJson = payload.openApiSpecJson;
              const hash = await computeSha256(specJson);
              const etag = `W/"sf_oas3_${hash.substring(0, 16)}"`;
              const now = Date.now();
              memoryOpenApiSpecCache.set(instanceOrigin, { json: specJson, etag, timestamp: now });
              const r2Key = await saveSpecToR2(env, instanceOrigin, specJson);
              if (env.DB) {
                await env.DB.prepare(
                  "INSERT OR REPLACE INTO sf_openapi_cache (instance_url, etag, locator_id, r2_key, updated_at) VALUES (?, ?, NULL, ?, ?)"
                ).bind(instanceOrigin, etag, r2Key, now).run();
              }
              console.log(`✅ Cached OpenAPI Spec from webhook payload for ${instanceOrigin}`);
            } catch (specErr) {
              console.error("Error caching openApiSpecJson from webhook:", specErr);
            }
          }
        } else {
          console.log("=================================================");
        }

        return new Response(
          JSON.stringify({
            status: "success",
            message: "Cloudflare Executor (host-cloudflare) successfully received and logged MCP & REST API OpenAPI credentials webhook payload",
            orgId: payload.orgId,
            mcpServerUrl: payload.mcpServerUrl,
            restApiUrl: payload.restApiUrl,
            openApiSpecUrl: payload.openApiSpecUrl,
            cachedOpenApiSpecUrl: viewableOpenApiUrl,
            queryUrl: payload.queryUrl,
            sobjectsUrl: payload.sobjectsUrl,
            clientId: payload.clientId,
            logId: logId,
            logUrl: logCurlUrl,
            receivedAt: new Date().toISOString()
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
          }
        );
      } catch (err: any) {
        console.error("❌ Error parsing Salesforce MCP webhook payload:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 400 });
      }
    }


    // -------------------------------------------------------------------------
    // 2. Real-Time Schema Invalidation Webhook (/api/sf/webhook/schema-changed)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/webhook/schema-changed") && request.method === "POST") {
      try {
        const body = (await request.json()) as { instance_url?: string; domain?: string };
        let instanceUrl = body.instance_url;
        if (!instanceUrl && body.domain) {
          instanceUrl = body.domain.startsWith("http") ? body.domain : `https://${body.domain}`;
        }

        if (instanceUrl) {
          await invalidateOpenApiCache(env, instanceUrl);
          return new Response(JSON.stringify({ status: "success", message: `Cache invalidated for ${instanceUrl}` }), {
            status: 200,
            headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        return new Response(JSON.stringify({ error: "Missing instance_url or domain" }), { status: 400 });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // 3. Dynamic Account-Specific OpenAPI Spec Endpoint (/api/sf/openapi.json)
    // -------------------------------------------------------------------------
    if ((pathname.includes("openapi") || pathname.includes("/sf/openapi")) && request.method === "GET") {
      const authHeader = request.headers.get("Authorization");
      let apiKey = url.searchParams.get("api_key") || "";
      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7).trim();
      }

      const record = await getApiKeyRecord(env, apiKey);
      if (!record) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid or expired API Key" }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const forceRefresh = url.searchParams.get("refresh") === "true" || url.searchParams.get("force") === "1";
      const ifNoneMatch = request.headers.get("If-None-Match");

      try {
        const { specJson, etag, cachedHit } = await getOrGenerateOpenApiSpec(env, record, forceRefresh);

        if (ifNoneMatch && ifNoneMatch === etag && !forceRefresh) {
          return new Response(null, {
            status: 304,
            headers: {
              "ETag": etag,
              "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
              "Access-Control-Allow-Origin": "*",
              "X-OpenAPI-Cache": "HIT",
            },
          });
        }

        return new Response(specJson, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "ETag": etag,
            "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
            "Access-Control-Allow-Origin": "*",
            "X-OpenAPI-Cache": cachedHit ? "HIT" : "MISS",
            "X-OpenAPI-Source": "salesforce-oas3-beta",
          },
        });
      } catch (err: any) {
        // Job started but not yet complete — return 202 Accepted with retry hint
        if ((err.message as string).startsWith("PENDING:")) {
          return new Response(
            JSON.stringify({
              status: "generating",
              message: "Salesforce OpenAPI 3.0 spec is being generated. Retry in ~10-30 seconds.",
              retry_after: 10,
            }),
            {
              status: 202,
              headers: {
                "content-type": "application/json",
                "Retry-After": "10",
                "Access-Control-Allow-Origin": "*",
                "X-OpenAPI-Cache": "MISS",
              },
            }
          );
        }
        return new Response(
          JSON.stringify({ error: `Failed to generate OpenAPI spec: ${err.message}` }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    // -------------------------------------------------------------------------
    // 4. Salesforce Hosted MCP Proxy Endpoint (/api/sf/mcp)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/mcp") && (request.method === "POST" || request.method === "GET")) {
      const authHeader = request.headers.get("Authorization");
      let apiKey = url.searchParams.get("api_key");
      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7).trim();
      }

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Missing API Key. Provide via Authorization header 'Bearer sf_key_...' or ?api_key=sf_key_..." }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const record = await getApiKeyRecord(env, apiKey);
      if (!record) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid or expired API Key" }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const reqBody = request.method === "POST" ? await request.text() : undefined;
      let sfRes = await executeSfRequest(env, record, "/services/apexrest/mcp/v1/headless360", request.method, reqBody);
      if (sfRes.status === 200) {
        const resText = await sfRes.text();
        return new Response(resText, {
          status: 200,
          headers: {
            "content-type": sfRes.headers.get("content-type") || "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      let jsonReq: any = {};
      try {
        if (reqBody) jsonReq = JSON.parse(reqBody);
      } catch (_) {}

      const reqId = jsonReq.id || 1;
      const method = jsonReq.method || "tools/list";

      let responsePayload: any;
      if (method === "initialize") {
        responsePayload = {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "Salesforce Headless 360 MCP Server",
              version: "1.0.0"
            }
          }
        };
      } else {
        responsePayload = {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            tools: [
              {
                name: "discover",
                description: "Finds the Salesforce operations and actions your agent can take by performing semantic search across available platform capabilities.",
                inputSchema: {
                  type: "object",
                  properties: { intent: { type: "string", description: "Natural language prompt describing what the agent wants to do" } },
                  required: ["intent"]
                }
              },
              {
                name: "describe",
                description: "Returns the full technical specification for a chosen Salesforce operation, including parameters, APIs, dependencies, and ordered steps.",
                inputSchema: {
                  type: "object",
                  properties: { operationId: { type: "string", description: "Operation ID returned from discover tool" } },
                  required: ["operationId"]
                }
              },
              {
                name: "dispatch",
                description: "Invokes and executes a chosen Salesforce operation (read, write, update, delete, or setup modification).",
                inputSchema: {
                  type: "object",
                  properties: {
                    operationId: { type: "string" },
                    parameters: { type: "object" }
                  },
                  required: ["operationId", "parameters"]
                }
              },
              {
                name: "dispatch_readonly",
                description: "Invokes and executes a chosen Salesforce operation in strictly read-only mode to retrieve data without altering configuration.",
                inputSchema: {
                  type: "object",
                  properties: {
                    operationId: { type: "string" },
                    parameters: { type: "object" }
                  },
                  required: ["operationId"]
                }
              }
            ]
          }
        };
      }

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // -------------------------------------------------------------------------
    // 5a. Salesforce REST Proxy Query Route (/api/sf/query)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/query") && request.method === "GET") {
      const authHeader = request.headers.get("Authorization");
      let apiKey = url.searchParams.get("api_key");
      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7).trim();
      }

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Missing API Key. Provide via Authorization header 'Bearer sf_key_...' or ?api_key=sf_key_..." }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const q = url.searchParams.get("q");
      if (!q) {
        return new Response(
          JSON.stringify({ error: "Missing SOQL query parameter: ?q=SELECT+Id,Name+FROM+Account" }),
          { status: 400, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const record = await getApiKeyRecord(env, apiKey);
      if (!record) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid or expired API Key" }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Fix: Salesforce SOQL query endpoint is /services/data/v61.0/query?q=... (NO trailing slash!)
      const endpointPath = `/services/data/v61.0/query?q=${encodeURIComponent(q)}`;
      const sfRes = await executeSfRequest(env, record, endpointPath, "GET");

      const sfData = await sfRes.json();
      return new Response(JSON.stringify(sfData), {
        status: sfRes.status,
        headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // -------------------------------------------------------------------------
    // 5b. Salesforce REST Proxy SObjects Route (/api/sf/sobjects/*)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/sobjects") && (request.method === "GET" || request.method === "POST" || request.method === "PATCH" || request.method === "DELETE")) {
      const authHeader = request.headers.get("Authorization");
      let apiKey = url.searchParams.get("api_key");
      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7).trim();
      }

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Missing API Key. Provide via Authorization header 'Bearer sf_key_...' or ?api_key=sf_key_..." }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const record = await getApiKeyRecord(env, apiKey);
      if (!record) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid or expired API Key" }),
          { status: 401, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const sobjectsSubpath = pathname.substring(pathname.indexOf("/sf/sobjects") + 12);
      const searchParams = new URLSearchParams(url.search);
      searchParams.delete("api_key");
      const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
      const endpointPath = `/services/data/v61.0/sobjects${sobjectsSubpath}${cleanSearch}`;

      const reqBody = (request.method === "POST" || request.method === "PATCH") ? await request.text() : undefined;
      const sfRes = await executeSfRequest(env, record, endpointPath, request.method, reqBody);

      const resText = await sfRes.text();
      return new Response(resText, {
        status: sfRes.status,
        headers: {
          "content-type": sfRes.headers.get("content-type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // -------------------------------------------------------------------------
    // 6. OAuth Callback Route (/api/oauth/sf/callback)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/callback") && request.method === "GET") {
      const code = url.searchParams.get("code");
      const stateStr = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      const oauthErrorDesc = url.searchParams.get("error_description");

      if (oauthError) {
        return new Response(
          JSON.stringify({ error: oauthError, description: oauthErrorDesc }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      if (!code || !stateStr) {
        return new Response(
          JSON.stringify({ error: "Missing code or state in callback" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      let statePayload: { domain: string; clientId: string; verifier: string };
      try {
        statePayload = JSON.parse(atob(stateStr));
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid state token format" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const redirectUri = "https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/sf/callback";
      const tokenEndpoint = `https://${statePayload.domain}/services/oauth2/token`;

      const bodyParams = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: statePayload.clientId,
        redirect_uri: redirectUri,
        code_verifier: statePayload.verifier,
        code,
      });

      const tokenRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: bodyParams.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return new Response(
          JSON.stringify({
            error: "Failed to exchange token with Salesforce",
            status: tokenRes.status,
            details: errText,
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }

      const tokenData = (await tokenRes.json()) as SalesforceTokenResponse;

      // Generate API Key
      const apiKey = "sf_key_" + crypto.randomUUID().replace(/-/g, "");

      // Save record in memory store
      const sfRecord: SfApiKeyRecord = {
        api_key: apiKey,
        instance_url: tokenData.instance_url,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || "",
        client_id: statePayload.clientId,
        created_at: Date.now(),
      };
      memoryApiKeyStore.set(apiKey, sfRecord);

      // Save to Cloudflare D1 Database
      if (env.DB) {
        try {
          await ensureD1Tables(env.DB);
          await env.DB.prepare(`
            INSERT OR REPLACE INTO sf_api_keys (api_key, instance_url, access_token, refresh_token, client_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            apiKey,
            tokenData.instance_url,
            tokenData.access_token,
            tokenData.refresh_token || "",
            statePayload.clientId,
            Date.now()
          ).run();
        } catch (dbErr) {
          console.error("Failed to save API key to D1:", dbErr);
        }
      }

      // Automatically trigger OpenAPI 3.0 Spec Generation (Beta) job from Salesforce
      try {
        await getOrGenerateOpenApiSpec(env, sfRecord, true);
      } catch (genErr) {
        console.log("Automatic post-login OpenAPI Spec generation initiated:", genErr);
      }

      // Formulate URLs
      const mcpProxyUrl = `https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/mcp`;
      const directMcpUrl = `${tokenData.instance_url}/services/mcp/v1.0`;
      const openApiSpecUrl = `https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/openapi.json?api_key=${apiKey}`;
      // Salesforce has no native OpenAPI endpoint; use global describe (sobjects) as the raw schema reference
      const directOpenApiUrl = `${tokenData.instance_url}/services/data/v61.0/sobjects/`;
      
      const rawAccountRestUrl = `${tokenData.instance_url}/services/data/v61.0/sobjects/Account`;
      const rawBaseRestUrl = `${tokenData.instance_url}/services/data/v61.0/`;
      const rawQueryUrl = `${tokenData.instance_url}/services/data/v61.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+10`;

      const proxiedAccountRestUrl = `https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/sobjects/Account?api_key=${apiKey}`;
      const proxiedQueryUrl = `https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/query?api_key=${apiKey}&q=SELECT+Id,Name+FROM+Account+LIMIT+10`;

      const rawMcpConfigSnippet = JSON.stringify(
        {
          mcpServers: {
            "salesforce-raw-direct-mcp": {
              url: directMcpUrl,
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                "X-SFDC-Session": tokenData.access_token,
              },
            },
          },
        },
        null,
        2
      );

      const proxiedMcpConfigSnippet = JSON.stringify(
        {
          mcpServers: {
            "executor-proxied-salesforce-mcp": {
              url: mcpProxyUrl,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            },
          },
        },
        null,
        2
      );

      // HTML response displaying Raw Direct REST API & OpenAPI, Raw Direct MCP, EXECUTOR Proxied MCP & REST API
      const htmlOutput = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Salesforce OpenAPI Spec & MCP Ready</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 30px 20px; }
          .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 36px; max-width: 800px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.6); }
          .icon { width: 48px; height: 48px; background: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 24px; color: #fff; }
          h2 { margin: 0 0 8px 0; font-size: 26px; color: #ffffff; }
          p { color: #9ca3af; margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; }
          .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
          .section-title { font-size: 16px; font-weight: 700; color: #60a5fa; margin: 24px 0 12px 0; border-bottom: 1px solid #1f2937; padding-bottom: 6px; }
          .key-box { background: #064e3b; border: 1px solid #059669; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 15px; color: #6ee7b7; word-break: break-all; margin-bottom: 16px; user-select: all; }
          .info-box { background: #1f2937; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 12px; color: #d1d5db; word-break: break-all; margin-bottom: 16px; white-space: pre-wrap; }
          .btn { background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; display: inline-block; font-weight: 500; font-size: 14px; margin-top: 10px; margin-right: 10px; }
          .label { font-weight: 600; color: #9ca3af; font-size: 12px; text-transform: uppercase; margin-bottom: 6px; display: block; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <span class="badge">Salesforce REST API, OpenAPI Spec & MCP Active</span>
          <h2>Your Salesforce Account API & Specs</h2>
          <p>Your Salesforce account is connected. Below are your account's <strong>Raw Direct Salesforce REST API & OpenAPI endpoints</strong>, as well as EXECUTOR's proxied endpoints & generated <strong>OpenAPI 3.0 Specification</strong>.</p>

          <!-- SECTION 1: RAW DIRECT SALESFORCE REST API & OPENAPI FROM ACCOUNT -->
          <div class="section-title">1. Raw Direct Salesforce Account REST API & OpenAPI (Not Proxied)</div>

          <span class="label">Raw Salesforce Account SObject REST API Endpoint:</span>
          <div class="info-box">${rawAccountRestUrl}</div>

          <span class="label">Raw Salesforce Base REST API URL:</span>
          <div class="info-box">${rawBaseRestUrl}</div>

          <span class="label">Raw Salesforce SOQL Query URL:</span>
          <div class="info-box">${rawQueryUrl}</div>

          <span class="label">Raw Salesforce Global Schema Describe (SObjects List) — Salesforce has no native OpenAPI spec:</span>
          <div class="info-box">${directOpenApiUrl}</div>

          <!-- SECTION 2: DYNAMIC OPENAPI 3.0 SPECIFICATION -->
          <div class="section-title">2. EXECUTOR Account-Specific OpenAPI 3.0 Specification</div>
          
          <span class="label">Generated OpenAPI 3.0 Specification JSON URL:</span>
          <div class="info-box">${openApiSpecUrl}</div>

          <a href="${openApiSpecUrl}" target="_blank" class="btn">View / Download OpenAPI Spec (JSON)</a>

          <!-- SECTION 3: RAW DIRECT SALESFORCE HOSTED MCP -->
          <div class="section-title">3. Raw Direct Salesforce Hosted MCP (Not Proxied)</div>
          
          <span class="label">Raw Salesforce Hosted MCP Endpoint:</span>
          <div class="info-box">${directMcpUrl}</div>

          <span class="label">Raw OAuth PKCE Access Token:</span>
          <div class="key-box">${tokenData.access_token}</div>

          <span class="label">Raw MCP Headers:</span>
          <div class="info-box">Authorization: Bearer ${tokenData.access_token}
X-SFDC-Session: ${tokenData.access_token}
Content-Type: application/json</div>

          <span class="label">Raw Direct MCP Settings (mcpServers JSON):</span>
          <div class="info-box">${rawMcpConfigSnippet}</div>

          <!-- SECTION 4: EXECUTOR PROXIED SALESFORCE MCP & REST API -->
          <div class="section-title">4. EXECUTOR Proxied Salesforce MCP & REST API</div>
          
          <span class="label">Your Generated EXECUTOR API Key:</span>
          <div class="key-box">${apiKey}</div>

          <span class="label">EXECUTOR Proxied Account SObject REST Endpoint:</span>
          <div class="info-box">${proxiedAccountRestUrl}</div>

          <span class="label">EXECUTOR Proxied SOQL Query Endpoint:</span>
          <div class="info-box">${proxiedQueryUrl}</div>

          <span class="label">EXECUTOR Proxied MCP Endpoint:</span>
          <div class="info-box">${mcpProxyUrl}</div>

          <span class="label">EXECUTOR Proxied MCP Settings (mcpServers JSON):</span>
          <div class="info-box">${proxiedMcpConfigSnippet}</div>

          <a href="/" class="btn">Return to EXECUTOR Console</a>
        </div>
      </body>
      </html>
      `;

      return new Response(htmlOutput, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // -------------------------------------------------------------------------
    // 7. Token Refresh Route (/api/oauth/sf/refresh)
    // -------------------------------------------------------------------------
    if (pathname.includes("/sf/refresh") && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          domain: string;
          clientId?: string;
          refreshToken: string;
        };

        const DEFAULT_CLIENT_ID = "3MVG97L7PWbPq6UwRxF9421lWKMABDZvIzl3DO3ZCWVhC.SnVSux.NzBA55Tw0UoVHsTviflTVFUhGhXPDvv.";
        const clientId = body.clientId || DEFAULT_CLIENT_ID;

        if (!body.domain || !body.refreshToken) {
          return new Response(
            JSON.stringify({ error: "Missing domain or refreshToken" }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }

        const tokenEndpoint = `https://${body.domain}/services/oauth2/token`;
        const bodyParams = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: body.refreshToken,
        });

        const refreshRes = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: bodyParams.toString(),
        });

        const refreshData = await refreshRes.json();
        return new Response(JSON.stringify(refreshData), {
          status: refreshRes.status,
          headers: { "content-type": "application/json" },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };
}
