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

/**
 * Creates the Cloudflare Worker Web Handler for Salesforce OAuth 2.0 PKCE Flow
 */
export function makeSalesforceOAuthHandler(config: CloudflareConfig, env: CloudflareEnv) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // -------------------------------------------------------------------------
    // 1. Authorize Route (/api/oauth/sf/authorize)
    // Initiates PKCE OAuth flow with client Salesforce Org domain & Consumer Key
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/sf/authorize" && request.method === "GET") {
      const sfDomain = url.searchParams.get("domain") || "login.salesforce.com";
      const clientId = url.searchParams.get("consumer_key");

      if (!clientId) {
        return new Response(
          JSON.stringify({ error: "Missing required parameter: consumer_key" }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const verifier = await generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      const statePayload = {
        domain: sfDomain,
        clientId,
        verifier,
        nonce: crypto.randomUUID(),
      };

      const stateStr = btoa(JSON.stringify(statePayload));
      const redirectUri = "https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/callback";

      const authUrl = new URL(`https://${sfDomain}/services/oauth2/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("scope", "mcp_api refresh_token api id");
      authUrl.searchParams.set("state", stateStr);

      return Response.redirect(authUrl.toString(), 302);
    }

    // -------------------------------------------------------------------------
    // 2. OAuth Callback Route (/api/oauth/callback)
    // Handles redirect back from Salesforce with auth code & performs PKCE token exchange
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/callback" && request.method === "GET") {
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

      const redirectUri = "https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/callback";
      const tokenEndpoint = `https://${statePayload.domain}/services/oauth2/token`;

      // Public Client PKCE Token Exchange: NO client_secret required!
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

      // HTML response confirming successful Salesforce MCP connection
      const htmlOutput = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Salesforce MCP Connected</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 500px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          .icon { width: 48px; height: 48px; background: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 20px; }
          h2 { margin: 0 0 8px 0; font-size: 24px; color: #ffffff; }
          p { color: #9ca3af; margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; }
          .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
          .info-box { background: #1f2937; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #d1d5db; word-break: break-all; margin-bottom: 20px; }
          .btn { background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; display: inline-block; font-weight: 500; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <span class="badge">Salesforce MCP Connection Active</span>
          <h2>Successfully Authenticated!</h2>
          <p>EXECUTOR is now connected to Salesforce Hosted MCP via Public Client PKCE Bypass.</p>
          <div class="info-box">
            Instance: ${tokenData.instance_url}<br/>
            Scope: ${tokenData.scope}<br/>
            Identity: ${tokenData.id}
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
    // 3. Token Refresh Route (/api/oauth/sf/refresh)
    // Refreshes expired access tokens without client_secret
    // -------------------------------------------------------------------------
    if (pathname === "/api/oauth/sf/refresh" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          domain: string;
          clientId: string;
          refreshToken: string;
        };

        if (!body.domain || !body.clientId || !body.refreshToken) {
          return new Response(
            JSON.stringify({ error: "Missing domain, clientId, or refreshToken" }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }

        const tokenEndpoint = `https://${body.domain}/services/oauth2/token`;
        const bodyParams = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: body.clientId,
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
