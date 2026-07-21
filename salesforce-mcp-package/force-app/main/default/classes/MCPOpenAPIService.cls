/**
 * @description Controller and REST Endpoint for Salesforce REST API OpenAPI 3.0 spec generation and retrieval.
 */
@RestResource(urlMapping='/mcp/v1/openapi/*')
global with sharing class MCPOpenAPIService {

    /**
     * REST GET endpoint to generate and return OpenAPI 3.0 JSON specification
     */
    @HttpGet
    global static void getOpenApiSpec() {
        RestResponse res = RestContext.response;
        if (res == null) {
            res = new RestResponse();
            RestContext.response = res;
        }
        res.addHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.responseBody = Blob.valueOf(generateOpenApiSpecJson());
    }

    /**
     * Generates OpenAPI 3.0 JSON Spec for the Org's REST API and Hosted MCP Tools
     */
    public static String generateOpenApiSpecJson() {
        String orgDomain = URL.getOrgDomainUrl().toExternalForm();
        Map<String, Object> spec = new Map<String, Object>{
            'openapi' => '3.0.3',
            'info' => new Map<String, Object>{
                'title' => 'Salesforce Org REST API & Hosted MCP 360',
                'version' => '1.0.0',
                'description' => 'OpenAPI 3.0 Specification for Salesforce Org REST APIs, SOQL Query, SObjects, and Headless 360 MCP Endpoint'
            },
            'servers' => new List<Object>{
                new Map<String, Object>{
                    'url' => orgDomain,
                    'description' => 'Current Salesforce Org Domain'
                }
            },
            'paths' => new Map<String, Object>{
                '/services/mcp/v1.0/headless360' => new Map<String, Object>{
                    'post' => new Map<String, Object>{
                        'summary' => 'Salesforce Hosted MCP Headless 360 Protocol Endpoint',
                        'operationId' => 'invokeMcpProtocol',
                        'responses' => new Map<String, Object>{
                            '200' => new Map<String, Object>{ 'description' => 'MCP Protocol JSON-RPC Response' }
                        }
                    }
                },
                '/services/data/v67.0/query' => new Map<String, Object>{
                    'get' => new Map<String, Object>{
                        'summary' => 'Execute SOQL Query',
                        'operationId' => 'querySoql',
                        'parameters' => new List<Object>{
                            new Map<String, Object>{
                                'name' => 'q',
                                'in' => 'query',
                                'required' => true,
                                'schema' => new Map<String, Object>{ 'type' => 'string' },
                                'description' => 'SOQL Query String'
                            }
                        },
                        'responses' => new Map<String, Object>{
                            '200' => new Map<String, Object>{ 'description' => 'Query Records Response' }
                        }
                    }
                },
                '/services/data/v67.0/sobjects/{sobjectName}' => new Map<String, Object>{
                    'get' => new Map<String, Object>{
                        'summary' => 'Describe SObject Metadata',
                        'operationId' => 'describeSObject'
                    },
                    'post' => new Map<String, Object>{
                        'summary' => 'Create SObject Record',
                        'operationId' => 'createSObject'
                    }
                },
                '/services/apexrest/mcp/v1/credentials/' => new Map<String, Object>{
                    'get' => new Map<String, Object>{
                        'summary' => 'Retrieve Hosted MCP Credentials & Endpoints',
                        'operationId' => 'getMcpCredentials',
                        'responses' => new Map<String, Object>{
                            '200' => new Map<String, Object>{ 'description' => 'Credentials and Endpoints Payload' }
                        }
                    }
                },
                '/services/apexrest/mcp/v1/openapi/' => new Map<String, Object>{
                    'get' => new Map<String, Object>{
                        'summary' => 'Retrieve OpenAPI 3.0 JSON Specification',
                        'operationId' => 'getOpenApiSpec',
                        'responses' => new Map<String, Object>{
                            '200' => new Map<String, Object>{ 'description' => 'OpenAPI 3.0 JSON Specification' }
                        }
                    }
                }
            }
        };
        return JSON.serializePretty(spec);
    }

    /**
     * Triggers standard Salesforce async OAS3 Beta generation if callouts are permitted
     */
    @future(callout=true)
    public static void triggerSalesforceOas3GenerationAsync(String sessionOrAccessToken) {
        try {
            String orgDomain = URL.getOrgDomainUrl().toExternalForm();
            String endpoint = orgDomain + '/services/data/v67.0/async/specifications/oas3';
            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + sessionOrAccessToken);
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(new Map<String, Object>{ 'resources' => new List<String>{ '*' } }));
            req.setTimeout(15000);

            Http http = new Http();
            HttpResponse res = http.send(req);
            System.debug(LoggingLevel.INFO, 'Salesforce Async OAS3 Generation Trigger Response [' + res.getStatusCode() + ']: ' + res.getBody());
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'OAS3 Callout trigger note: ' + ex.getMessage());
        }
    }
}
