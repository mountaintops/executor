import type { CloudflareConfig, CloudflareEnv } from "../config";

// Helper for Base64URL encoding (RFC 4648)
function base64UrlEncode(array: Uint8Array): string {
  let str = "";
  for (let i = 0; i < array.length; i++) {
    str += String.fromCharCode(array[i]);
  }
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Generate PKCE code verifier (32 random bytes -> 43 base64url chars)
export async function generateCodeVerifier(): Promise<string> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// Generate PKCE code challenge (SHA-256 hash of verifier -> base64url)
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

export interface SalesforceTokenResponse {
  access_token: string;
  refresh_token?: string;
  signature: string;
  scope: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
}

export interface SfApiKeyRecord {
  api_key: string;
  instance_url: string;
  access_token: string;
  refresh_token: string;
  client_id: string;
  created_at: number;
}

/**
 * Ensures D1 table for storing API keys exists
 */
async function ensureD1Table(db: D1Database): Promise<void> {
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
}

/**
 * Helper to provision External Client App via Salesforce SOAP Metadata API
 */
async function provisionEcaViaMetadataApi(domain: string, sessionId: string): Promise<{ success: boolean; error?: string }> {
  const soapEndpoint = `https://${domain}/services/Soap/m/61.0`;

  const ecaEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader>
      <met:sessionId>${sessionId}</met:sessionId>
    </met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:createMetadata>
      <met:metadata xsi:type="met:ExternalClientApplication" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <met:fullName>ExecutorMCP</met:fullName>
        <met:label>Executor Cloudflare MCP Integration</met:label>
        <met:contactEmail>admin@emalteaproductions.com</met:contactEmail>
        <met:distributionState>Local</met:distributionState>
      </met:metadata>
    </met:createMetadata>
  </soapenv:Body>
</soapenv:Envelope>`;

  const ecaRes = await fetch(soapEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      "SOAPAction": "createMetadata",
    },
    body: ecaEnvelope,
  });

  const ecaText = await ecaRes.text();
  if (ecaText.includes("<success>false</success>") && !ecaText.includes("DUPLICATE_DEVELOPER_NAME")) {
    return { success: false, error: `Metadata API ECA creation failed: ${ecaText}` };
  }

  return { success: true };
}

/**
 * Fetch record for a given API key from D1 or memory
 */
async function getApiKeyRecord(env: CloudflareEnv, apiKey: string): Promise<SfApiKeyRecord | null> {
  if (!env.DB) return null;
  try {
    await ensureD1Table(env.DB);
    const row = await env.DB.prepare("SELECT * FROM sf_api_keys WHERE api_key = ?").bind(apiKey).first<SfApiKeyRecord>();
    return row || null;
  } catch (err) {
    console.error("D1 lookup error:", err);
    return null;
  }
}

/**
 * Execute Salesforce REST API request with automatic token refresh
 */
async function executeSfRestRequest(env: CloudflareEnv, record: SfApiKeyRecord, endpointPath: string): Promise<Response> {
  let sfUrl = `${record.instance_url}${endpointPath}`;
  let res = await fetch(sfUrl, {
    headers: {
      Authorization: `Bearer ${record.access_token}`,
      Accept: "application/json",
    },
  });

  // If token expired, attempt refresh automatically
  if (res.status === 401 && record.refresh_token && record.client_id) {
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
      const refreshData = (await refreshRes.json()) as { access_token: string };
      record.access_token = refreshData.access_token;

      // Update D1
      if (env.DB) {
        await env.DB.prepare("UPDATE sf_api_keys SET access_token = ? WHERE api_key = ?").bind(record.access_token, record.api_key).run();
      }

      // Retry request with fresh access token
      res = await fetch(sfUrl, {
        headers: {
          Authorization: `Bearer ${record.access_token}`,
          Accept: "application/json",
        },
      });
    }
  }

  return res;
}

/**
 * Creates the Cloudflare Worker Web Handler for Salesforce OAuth 2.0 PKCE Flow & REST Proxy API
 */
export function makeSalesforceOAuthHandler(config: CloudflareConfig, env: CloudflareEnv) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // -------------------------------------------------------------------------
    // 0. Auto-Provisioning Route (/api/oauth/sf/provision)
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/sf/provision" && request.method === "POST") {
      try {
        const body = (await request.json()) as { domain: string; session_id: string };
        if (!body.domain || !body.session_id) {
          return new Response(
            JSON.stringify({ error: "Missing required parameters: domain, session_id" }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }

        const result = await provisionEcaViaMetadataApi(body.domain, body.session_id);
        if (!result.success) {
          return new Response(
            JSON.stringify({ error: result.error || "Provisioning failed" }),
            { status: 500, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "Successfully provisioned External Client Application in client org!",
            next_step: "Call /api/oauth/sf/authorize to complete secretless PKCE connection",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message || "Provisioning endpoint error" }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    // -------------------------------------------------------------------------
    // 1. Authorize Route (/api/oauth/sf/authorize)
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/sf/authorize" && request.method === "GET") {
      const sfDomain = url.searchParams.get("domain") || "login.salesforce.com";
      const DEFAULT_CLIENT_ID = "3MVG97L7PWbPq6UwRxF9421lWKMABDZvIzl3DO3ZCWVhC.SnVSux.NzBA55Tw0UoVHsTviflTVFUhGhXPDvv.";
      const clientId = url.searchParams.get("consumer_key") || DEFAULT_CLIENT_ID;

      const verifier = await generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      const statePayload = {
        domain: sfDomain,
        clientId,
        verifier,
        nonce: crypto.randomUUID(),
      };

      const stateStr = btoa(JSON.stringify(statePayload));
      const redirectUri = "https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/sf/callback";

      const authUrl = new URL(`https://${sfDomain}/services/oauth2/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("scope", "api refresh_token id chatter_api");
      authUrl.searchParams.set("state", stateStr);

      return Response.redirect(authUrl.toString(), 302);
    }

    // -------------------------------------------------------------------------
    // 2. OAuth Callback Route (/api/oauth/sf/callback)
    // -------------------------------------------------------------------------
    if ((pathname === "/api/oauth/sf/callback" || pathname === "/api/oauth/callback") && request.method === "GET") {
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

      // Save to Cloudflare D1 Database
      if (env.DB) {
        try {
          await ensureD1Table(env.DB);
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

      const queryUrlExample = `https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/query?q=SELECT+Id,Name,Type+FROM+Account+LIMIT+5`;
      const curlExample = `curl -H "Authorization: Bearer ${apiKey}" "${queryUrlExample}"`;

      // HTML response with API Key & REST Query instructions
      const htmlOutput = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Salesforce API Key & REST Access Active</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 650px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .icon { width: 48px; height: 48px; background: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 24px; color: #fff; }
          h2 { margin: 0 0 8px 0; font-size: 24px; color: #ffffff; }
          p { color: #9ca3af; margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; }
          .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
          .key-box { background: #064e3b; border: 1px solid #059669; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 16px; color: #6ee7b7; word-break: break-all; margin-bottom: 20px; user-select: all; }
          .info-box { background: #1f2937; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 12px; color: #d1d5db; word-break: break-all; margin-bottom: 20px; }
          .btn { background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; display: inline-block; font-weight: 500; font-size: 14px; }
          .label { font-weight: 600; color: #9ca3af; font-size: 12px; text-transform: uppercase; margin-bottom: 6px; display: block; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <span class="badge">Salesforce REST API Access Enabled</span>
          <h2>Your Generated Salesforce API Key</h2>
          <p>Use this API Key to query your Salesforce account directly via EXECUTOR's REST API endpoint.</p>
          
          <span class="label">Your API Key (Save This):</span>
          <div class="key-box">${apiKey}</div>

          <span class="label">cURL REST Query Example:</span>
          <div class="info-box">${curlExample}</div>

          <span class="label">Connected Instance:</span>
          <div class="info-box">
            Instance URL: ${tokenData.instance_url}<br/>
            REST Endpoint: https://executor-cloudflare.emalteaproductions.workers.dev/api/sf/query<br/>
            Scope: ${tokenData.scope}
          </div>
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
    // 3. Salesforce REST Proxy Query Route (/api/sf/query & /api/oauth/sf/query)
    // Allows querying client Salesforce org using the generated API Key
    // -------------------------------------------------------------------------
    if ((pathname === "/api/sf/query" || pathname === "/api/oauth/sf/query") && request.method === "GET") {
      const authHeader = request.headers.get("Authorization");
      let apiKey = url.searchParams.get("api_key");
      if (!apiKey && authHeader && authHeader.startsWith("Bearer ")) {
        apiKey = authHeader.substring(7).trim();
      }

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Missing API Key. Provide via Authorization header 'Bearer sf_key_...' or ?api_key=sf_key_..." }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }

      const q = url.searchParams.get("q");
      if (!q) {
        return new Response(
          JSON.stringify({ error: "Missing SOQL query parameter: ?q=SELECT+Id,Name+FROM+Account" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const record = await getApiKeyRecord(env, apiKey);
      if (!record) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid or expired API Key" }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }

      const endpointPath = `/services/data/v61.0/query/?q=${encodeURIComponent(q)}`;
      const sfRes = await executeSfRestRequest(env, record, endpointPath);

      const sfData = await sfRes.json();
      return new Response(JSON.stringify(sfData), {
        status: sfRes.status,
        headers: { "content-type": "application/json" },
      });
    }

    // -------------------------------------------------------------------------
    // 4. Token Refresh Route (/api/oauth/sf/refresh)
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/sf/refresh" && request.method === "POST") {
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
          JSON.stringify({ error: err?.message || "Refresh failed" }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}
