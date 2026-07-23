# Zero-Touch Enhanced Chat 2GP Unlocked Package (`salesforce-mcp-package`)

This Second-Generation Unlocked Package (2GP) deploys all native Salesforce **Messaging for In-App and Web (MIAW)** metadata and runtime automation scripts to eliminate manual Setup UI clicks.

---

## Package Directory Structure

```
salesforce-mcp-package/
├── sfdx-project.json
└── force-app/main/default/
    ├── messagingChannels/
    │   └── WebChat.messagingChannel-meta.xml      # Enhanced Chat (EmbeddedMessaging) Channel & Parameters
    ├── embeddedServiceConfig/
    │   └── WebChatDeployment.embeddedServiceConfig-meta.xml # Embedded Service Deployment configuration
    ├── brandingSets/
    │   └── WebChatBranding.brandingSet-meta.xml   # UI styling tokens (colors, font, position)
    ├── flows/
    │   └── RouteWebChat.flow-meta.xml             # Omni-Channel Routing Flow & Pre-chat linkage
    ├── cspTrustedSites/
    │   └── BTProxyDomain.cspTrustedSite-meta.xml  # Authorizes bt-proxy domain for cross-origin API/SSE
    ├── corsWhitelistOrigins/
    │   └── BTProxyOrigin.corsWhitelistOrigin-meta.xml # Whitelists bt-proxy for CORS cross-origin calls
    ├── permissionsets/
    │   └── MessagingAgent.permissionset-meta.xml  # Grants permissions for MessagingSession & MessagingEndUser
    └── classes/
        ├── PostInstallMessagingHandler.cls        # Apex InstallHandler automating post-deployment setup
        ├── PostInstallMessagingHandler.cls-meta.xml
        ├── PostInstallMessagingHandlerTest.cls    # 100% test coverage unit test
        └── PostInstallMessagingHandlerTest.cls-meta.xml
```

---

## Zero-Touch Post-Install Script (`PostInstallMessagingHandler`)

Upon package installation in any host org (Sandbox, UAT, or Production), the Apex `InstallHandler` executes automatically to perform runtime bindings:

1. **Messaging Channel Activation**: Sets `IsActive = true` on `WebChat` `MessagingChannel`.
2. **JWT Identity Provider Association**: Registers `bt-proxy` JWK keyset endpoint (`https://bt-proxy.yourdomain.com/auth/jwks`).
3. **Dynamic Queue Resolution**: Queries host org for target Queue IDs (`Group` of type `Queue`) to prevent hardcoded sandbox/prod ID mismatches.
4. **Agentforce AI Agent Binding**: Links the `MessagingChannel` to pre-configured Agentforce or Einstein Bot routing targets.
5. **Proxy Webhook Registration**: Automatically sets `https://bt-proxy.yourdomain.com/api/webhooks/salesforce` as the real-time conversation event listener.

---

## Deployment Commands (SF CLI)

```bash
# 1. Create 2GP Package Version
sf package version create --package salesforce-mcp-package --code-coverage --installation-key-bypass --wait 10

# 2. Install Package into Target Org (Runs PostInstallMessagingHandler automatically)
sf package install --package 04t000000000000AAA --target-org target-org-alias --wait 10
```
