# Salesforce Hosted MCP 2GP Unlocked Package

This directory contains the Second-Generation Unlocked Package (2GP) metadata for connecting **EXECUTOR on Cloudflare** to **Salesforce Hosted MCP** across client orgs without requiring an AppExchange Security Review queue or manually copied Client Secrets.

## Package Architecture

This package deploys an **External Client Application (ECA)** configured as a **Public Client with PKCE**:
- **`isConsumerSecretOptional: true`**: Configures Salesforce OAuth endpoints to allow access token generation without sending `client_secret`.
- **`isSecretRequiredForRefreshToken: false`**: Allows background access token refresh using `refresh_token` without sending `client_secret`.
- **`isPkceRequired: true`**: Mandates standard OAuth 2.0 PKCE (SHA-256 `code_challenge` / `code_verifier`).
- **Scopes**: `mcp_api`, `refresh_token`, `api`, `id`.
- **Callback URL**: `https://executor-cloudflare.emalteaproductions.workers.dev/api/oauth/callback`

## How to Build & Publish Package Version

1. Install the Salesforce CLI:
   ```bash
   npm install -g @salesforce/cli
   ```

2. Log in to your central Developer Hub org:
   ```bash
   sf org login web --set-default-dev-hub --alias DevHub
   ```

3. Run the automated package build script:
   ```bash
   ./scripts/build-package.sh DevHub
   ```

4. The script will output an installation URL starting with `04t...`:
   ```
   https://login.salesforce.com/packaging/installPackage.apexp?p0=04t...
   ```

5. Provide this link to client org admins. They click the link to install the package in their Salesforce org in seconds.
