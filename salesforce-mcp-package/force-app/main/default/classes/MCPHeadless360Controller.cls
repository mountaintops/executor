/**
 * @description Controller and REST Endpoint for retrieving Salesforce Headless 360 Hosted MCP Server URL, REST API, OpenAPI Spec URL, and OAuth credentials.
 */
@RestResource(urlMapping='/mcp/v1/credentials/*')
global with sharing class MCPHeadless360Controller {

    global class MCPCredentialsResponse {
        public String mcpServerUrl;
        public String restApiUrl;
        public String openApiSpecUrl;
        public String queryUrl;
        public String sobjectsUrl;
        public String clientId;
        public String clientSecret;
        public String serverType;
        public String status;
        public String orgId;
        public String timestamp;

        public MCPCredentialsResponse() {
            String orgDomain = URL.getOrgDomainUrl().toExternalForm();
            this.orgId = UserInfo.getOrganizationId();
            this.timestamp = String.valueOf(System.now());
            this.mcpServerUrl = orgDomain + '/services/apexrest/mcp/v1/headless360';
            this.restApiUrl = orgDomain + '/services/data/v67.0/';
            this.openApiSpecUrl = orgDomain + '/services/apexrest/mcp/v1/openapi';
            this.queryUrl = orgDomain + '/services/data/v67.0/query?q=';
            this.sobjectsUrl = orgDomain + '/services/data/v67.0/sobjects/';
        }
    }

    /**
     * REST GET endpoint to return Hosted MCP credentials and connection URLs
     */
    @HttpGet
    global static MCPCredentialsResponse getMCPCredentialsRest() {
        return fetchCredentialsInternal();
    }

    /**
     * AuraEnabled method for UI components or Apex invocations
     */
    @AuraEnabled(cacheable=true)
    public static MCPCredentialsResponse getMCPCredentials() {
        return fetchCredentialsInternal();
    }

    /**
     * Programmatically provisions or updates MCP configuration settings
     */
    @AuraEnabled
    public static MCPCredentialsResponse registerOrUpdateMCP(String customUrl, String clientId, String clientSecret) {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        if (config == null || config.Id == null) {
            config = new MCP_Config__c();
        }

        String orgDomain = URL.getOrgDomainUrl().toExternalForm();
        config.MCP_Server_URL__c = String.isNotBlank(customUrl) ? customUrl : orgDomain + '/services/mcp/v1.0/headless360';
        if (String.isNotBlank(clientId)) config.Client_Id__c = clientId;
        if (String.isNotBlank(clientSecret)) config.Client_Secret__c = clientSecret;
        config.Server_Type__c = 'Salesforce Hosted MCP (Headless 360)';
        config.Status__c = 'Active - Registered';

        upsert config;
        return fetchCredentialsInternal();
    }

    private static MCPCredentialsResponse fetchCredentialsInternal() {
        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        MCPCredentialsResponse resp = new MCPCredentialsResponse();

        if (config != null && String.isNotBlank(config.MCP_Server_URL__c)) {
            resp.mcpServerUrl = config.MCP_Server_URL__c;
            resp.clientId = config.Client_Id__c;
            resp.clientSecret = config.Client_Secret__c;
            resp.serverType = config.Server_Type__c;
            resp.status = config.Status__c;
        } else {
            resp.serverType = 'Salesforce Hosted MCP (Headless 360)';
            resp.status = 'Default Endpoint';
        }

        return resp;
    }
}
