/**
 * @description Post-install handler for Salesforce Hosted MCP / Headless 360 Auto-Registration package.
 * Automatically provisions org-level metadata, assigns Permission Sets, generates Client ID/Secret, and triggers Cloudflare Webhooks.
 */
global class MCPAutoRegisterInstaller implements InstallHandler {

    global void onInstall(InstallContext context) {
        try {
            // 1. Retrieve current Org domain URL
            String orgDomain = URL.getOrgDomainUrl().toExternalForm();
            String mcpEndpoint = orgDomain + '/services/apexrest/mcp/v1/headless360';
            
            // 2. Retrieve or create Org-level custom settings for MCP Config
            MCP_Config__c config = MCP_Config__c.getOrgDefaults();
            if (config == null || config.Id == null) {
                config = new MCP_Config__c();
            }
            
            config.MCP_Server_URL__c = mcpEndpoint;
            config.Server_Type__c = 'Salesforce Hosted MCP (Headless 360)';
            config.Status__c = 'Active - Registered';
            config.Webhook_URL__c = 'https://executor-cloudflare.emalteaproductions.workers.dev/webhook';
            
            if (String.isBlank(config.Client_Id__c)) {
                config.Client_Id__c = 'SFDC_MCP_CLIENT_' + String.valueOf(Crypto.getRandomInteger()).substring(0, 8);
            }
            if (String.isBlank(config.Client_Secret__c)) {
                config.Client_Secret__c = 'sec_' + EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(String.valueOf(Crypto.getRandomLong()) + UserInfo.getOrganizationId())));
            }
            
            upsert config;
            
            // 3. Automated Permission Set Assignment in @future method to avoid MIXED DML
            if (!Test.isRunningTest()) {
                autoAssignPermissionSetAsync(UserInfo.getUserId());
            } else {
                autoAssignPermissionSetSync(UserInfo.getUserId());
            }
            
            // 4. Trigger Asynchronous Webhook to Cloudflare Executor (Sending BOTH Client ID and Client Secret)
            if (!Test.isRunningTest()) {
                MCPWebhookService.sendRegistrationWebhook(
                    mcpEndpoint,
                    config.Client_Id__c,
                    config.Client_Secret__c,
                    config.Status__c,
                    UserInfo.getOrganizationId(),
                    config.Webhook_URL__c
                );
            }
            
            System.debug(LoggingLevel.INFO, 'MCP Auto-Register Post-Install Completed successfully.');
        } catch (Exception ex) {
            System.debug(LoggingLevel.ERROR, 'Error in MCPAutoRegisterInstaller: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }
    }

    @future
    public static void autoAssignPermissionSetAsync(Id userId) {
        autoAssignPermissionSetSync(userId);
    }

    public static void autoAssignPermissionSetSync(Id userId) {
        try {
            // 1. Auto-assign Agentforce & Einstein Permission Set Licenses (PSLs)
            List<PermissionSetLicense> psls = [
                SELECT Id, MasterLabel 
                FROM PermissionSetLicense 
                WHERE Status = 'Active' 
                  AND (MasterLabel LIKE '%Agent%' OR MasterLabel LIKE '%Einstein%')
            ];
            for (PermissionSetLicense psl : psls) {
                try {
                    List<PermissionSetLicenseAssign> existingPsl = [
                        SELECT Id FROM PermissionSetLicenseAssign 
                        WHERE PermissionSetLicenseId = :psl.Id AND AssigneeId = :userId 
                        LIMIT 1
                    ];
                    if (existingPsl.isEmpty()) {
                        insert new PermissionSetLicenseAssign(
                            PermissionSetLicenseId = psl.Id,
                            AssigneeId = userId
                        );
                        System.debug(LoggingLevel.INFO, 'Auto-assigned PSL: ' + psl.MasterLabel);
                    }
                } catch (Exception pslErr) {
                    System.debug(LoggingLevel.FINE, 'Skipped PSL: ' + psl.MasterLabel + ' - ' + pslErr.getMessage());
                }
            }

            // 2. Auto-assign Agentforce & MCP Permission Sets
            List<PermissionSet> psList = [
                SELECT Id, Name 
                FROM PermissionSet 
                WHERE Name IN ('MCP_Headless360_Admin', 'AgentPlatformBuilder', 'AgentforceServiceAgentBuilder')
            ];
            for (PermissionSet ps : psList) {
                try {
                    List<PermissionSetAssignment> existing = [
                        SELECT Id FROM PermissionSetAssignment 
                        WHERE PermissionSetId = :ps.Id AND AssigneeId = :userId 
                        LIMIT 1
                    ];
                    if (existing.isEmpty()) {
                        insert new PermissionSetAssignment(
                            PermissionSetId = ps.Id,
                            AssigneeId = userId
                        );
                        System.debug(LoggingLevel.INFO, 'Auto-assigned Permission Set ' + ps.Name + ' to User: ' + userId);
                    }
                } catch (Exception psErr) {
                    System.debug(LoggingLevel.WARN, 'Could not auto-assign PermissionSet ' + ps.Name + ': ' + psErr.getMessage());
                }
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'Error during auto-assignment: ' + e.getMessage());
        }
    }
}
