/**
 * @description Asynchronous Webhook Service for notifying Cloudflare Executor of successful MCP registration & auth setup.
 */
public with sharing class MCPWebhookService {

    @future(callout=true)
    public static void sendRegistrationWebhook(
        String mcpServerUrl, 
        String clientId, 
        String clientSecret, 
        String status, 
        String targetOrgId, 
        String customWebhookUrl
    ) {
        try {
            String webhookUrl = String.isNotBlank(customWebhookUrl) 
                ? customWebhookUrl 
                : 'https://executor-cloudflare.emalteaproductions.workers.dev/webhook';

            String orgDomain = URL.getOrgDomainUrl().toExternalForm();
            String restApiUrl = orgDomain + '/services/data/v67.0/';
            String openApiSpecUrl = orgDomain + '/services/apexrest/mcp/v1/openapi';
            String queryUrl = orgDomain + '/services/data/v67.0/query?q=';
            String sobjectsUrl = orgDomain + '/services/data/v67.0/sobjects/';

            String openApiSpecJson = MCPOpenAPIService.generateOpenApiSpecJson();

            Map<String, Object> payload = new Map<String, Object>{
                'event' => 'MCP_AUTO_REGISTER_SUCCESS',
                'orgId' => targetOrgId != null ? targetOrgId : UserInfo.getOrganizationId(),
                'mcpServerUrl' => mcpServerUrl,
                'restApiUrl' => restApiUrl,
                'openApiSpecUrl' => openApiSpecUrl,
                'openApiSpecJson' => openApiSpecJson,
                'queryUrl' => queryUrl,
                'sobjectsUrl' => sobjectsUrl,
                'clientId' => clientId,
                'clientSecret' => clientSecret,
                'status' => status,
                'timestamp' => String.valueOf(System.now()),
                'installedByUser' => UserInfo.getUserName()
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint(webhookUrl);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(payload));
            req.setTimeout(15000);

            Http http = new Http();
            HttpResponse res = http.send(req);
            System.debug(LoggingLevel.INFO, 'Cloudflare Executor Webhook Response [' + res.getStatusCode() + ']: ' + res.getBody());
        } catch (Exception ex) {
            System.debug(LoggingLevel.ERROR, 'Error sending Cloudflare Webhook: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }
    }
}
