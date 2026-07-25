# Salesforce Unlisted Unlocked Package: Auto-Registering Hosted MCP Tools (Headless 360 MCP)

This repository contains the complete Salesforce DX source code for an **Unlisted Unlocked Package** that automates the org-level configuration, metadata setup, and auto-registration for Salesforce's **Hosted MCP (Model Context Protocol)** servers—specifically targeting the **Headless 360 MCP Server**.

---

## 🌟 Solution Architecture Overview

Salesforce **Hosted MCP** provides built-in, managed Model Context Protocol endpoints allowing AI assistants (Claude Desktop, Cursor, Agentforce, custom LLM agents) to securely discover and invoke org-level tools, Apex actions, Flows, and data operations without requiring dedicated intermediate proxy servers.

### Key Components in this Package

1. **`MCPAutoRegisterInstaller.cls` (Apex Post-Install Script)**
   - Automatically executes upon package installation in target Salesforce orgs.
   - Detects the org's My Domain URL (`https://<instance>.my.salesforce.com`).
   - Auto-registers and provisions the Headless 360 MCP endpoint URL (`/services/mcp/v1.0/headless360`).
   - Populates org-default configuration settings in `MCP_Config__c`.

2. **`MCPHeadless360Controller.cls` (Apex Controller & REST Endpoint)**
   - Exposes an `@AuraEnabled` method and a REST API resource (`GET /services/apexrest/mcp/v1/credentials/`).
   - Dynamically returns the Hosted MCP Server URL, OAuth Client ID, Secret, Org ID, and activation status to authorized clients and CI/CD pipelines.

3. **`MCP_Config__c` (Hierarchy Custom Setting)**
   - Stores org-level MCP configuration metadata (Server URL, Client ID, Client Secret, Status).

4. **`MCP_Headless360_Admin` (Permission Set)**
   - Grants administrative access to manage and query MCP Hosted Server credentials.

---

## 🚀 Step-by-Step Package Build & Deployment Guide

### Prerequisites
- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) installed.
- Access to a Dev Hub org with 2nd Generation Packaging (2GP) enabled.

---

### Step 1: Create the Unlocked Unlisted Package

Run the following command to register the unlocked package in your Dev Hub:

```bash
sf package create \
  --name "SalesforceHostedMCPAutoRegister" \
  --description "Auto-registering hosted MCP tools for Salesforce Headless 360" \
  --package-type "Unlocked" \
  --path "force-app" \
  --target-dev-hub DevHub
```

---

### Step 2: Create a Package Version

Build an unlisted package version:

```bash
sf package version create \
  --package "SalesforceHostedMCPAutoRegister" \
  --installation-key-bypass \
  --wait 10 \
  --target-dev-hub DevHub
```

Upon successful creation, copy the Subscriber Package Version ID (format: `04t...`).

---

### Step 3: Install the Package in Target Org

To install the unlocked package into your target scratch org, sandbox, or production org:

```bash
sf package install \
  --package "04t000000000000AAA" \
  --target-org target-org-alias \
  --wait 10
```

> **Note:** The `MCPAutoRegisterInstaller` Apex post-install script will fire automatically upon package completion, registering the org's Headless 360 Hosted MCP endpoint and setting up default settings.

---

## 🔑 Retrieving MCP Server URL & OAuth Credentials

### Option A: Query via cURL / REST API

Send an authenticated GET request to the deployed REST endpoint:

```bash
curl -X GET "https://your-domain.my.salesforce.com/services/apexrest/mcp/v1/credentials/" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json"
```

**Sample JSON Response:**
```json
{
  "mcpServerUrl": "https://your-domain.my.salesforce.com/services/mcp/v1.0/headless360",
  "clientId": "SFDC_MCP_CLIENT_84920184",
  "clientSecret": "sec_89f1a23b...",
  "serverType": "Salesforce Hosted MCP (Headless 360)",
  "status": "Active - Registered",
  "orgId": "00D000000000001EAA",
  "timestamp": "2026-07-21 00:20:00"
}
```

---

### Option B: Query via Salesforce CLI (`sf apex run`)

Execute Apex anonymously to view the registered endpoint:

```bash
sf apex run --target-org target-org-alias --mcp-config
```

Apex script:
```apex
MCPHeadless360Controller.MCPCredentialsResponse creds = MCPHeadless360Controller.getMCPCredentials();
System.debug('MCP Server URL: ' + creds.mcpServerUrl);
System.debug('Client ID: ' + creds.clientId);
```

---

## 🛠 Connecting AI Clients (Cursor / Claude Desktop / Custom Agents)

Add the retrieved MCP Server details to your MCP client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "salesforce-headless-360": {
      "command": "npx",
      "args": [
        "-y",
        "@salesforce/mcp-server-headless360",
        "--url", "https://your-domain.my.salesforce.com/services/mcp/v1.0/headless360",
        "--client-id", "YOUR_CLIENT_ID",
        "--client-secret", "YOUR_CLIENT_SECRET"
      ]
    }
  }
}
```
