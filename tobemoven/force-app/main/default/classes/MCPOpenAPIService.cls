/**
 * @description Controller and REST Endpoint for Salesforce REST API & SObject OpenAPI 3.0 spec generation and retrieval.
 */
@RestResource(urlMapping='/mcp/v1/openapi/*')
global with sharing class MCPOpenAPIService {

    /**
     * REST GET endpoint to generate and return full OpenAPI 3.0 JSON specification
     */
    @HttpGet
    global static void getOpenApiSpec() {
        RestResponse res = RestContext.response;
        if (res == null) {
            res = new RestResponse();
            RestContext.response = res;
        }
        res.addHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        res.responseBody = Blob.valueOf(generateOpenApiSpecJson());
    }

    /**
     * Generates complete OpenAPI 3.0 JSON Spec for Org REST API, SObjects, and Hosted MCP Server
     */
    public static String generateOpenApiSpecJson() {
        String orgDomain = URL.getOrgDomainUrl().toExternalForm();
        Map<String, Object> spec = new Map<String, Object>{
            'openapi' => '3.0.3',
            'info' => new Map<String, Object>{
                'title' => 'Salesforce Org REST API & Hosted MCP 360',
                'version' => '1.0.0',
                'description' => 'Complete OpenAPI 3.0 Specification for Salesforce Org REST APIs, SObjects, SOQL Query, and Headless 360 Hosted MCP Server'
            },
            'servers' => new List<Object>{
                new Map<String, Object>{
                    'url' => orgDomain,
                    'description' => 'Current Salesforce Org Domain'
                }
            },
            'paths' => new Map<String, Object>(),
            'components' => new Map<String, Object>{
                'schemas' => new Map<String, Object>()
            }
        };

        Map<String, Object> pathsMap = (Map<String, Object>) spec.get('paths');
        Map<String, Object> schemasMap = (Map<String, Object>) ((Map<String, Object>) spec.get('components')).get('schemas');

        // Standard MCP & Apex REST Endpoints
        pathsMap.put('/services/apexrest/mcp/v1/headless360/', new Map<String, Object>{
            'post' => new Map<String, Object>{
                'summary' => 'Salesforce Hosted MCP Headless 360 Protocol Endpoint',
                'operationId' => 'invokeMcpProtocol',
                'responses' => new Map<String, Object>{
                    '200' => new Map<String, Object>{ 'description' => 'MCP Protocol JSON-RPC Response' }
                }
            }
        });

        pathsMap.put('/services/data/v67.0/query', new Map<String, Object>{
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
        });

        pathsMap.put('/services/apexrest/mcp/v1/credentials/', new Map<String, Object>{
            'get' => new Map<String, Object>{
                'summary' => 'Retrieve Hosted MCP Credentials & Endpoints',
                'operationId' => 'getMcpCredentials'
            }
        });

        pathsMap.put('/services/apexrest/mcp/v1/openapi/', new Map<String, Object>{
            'get' => new Map<String, Object>{
                'summary' => 'Retrieve OpenAPI 3.0 JSON Specification',
                'operationId' => 'getOpenApiSpec'
            }
        });

        // Dynamically inspect SObjects in Org to build comprehensive OpenAPI schema
        Map<String, Schema.SObjectType> globalDescribe = Schema.getGlobalDescribe();
        Integer count = 0;
        for (String sName : globalDescribe.keySet()) {
            Schema.DescribeSObjectResult d = globalDescribe.get(sName).getDescribe();
            if (!d.isQueryable() || d.isDeprecatedAndHidden()) continue;
            count++;
            if (count > 200) break;

            String apiName = d.getName();
            String label = d.getLabel();

            pathsMap.put('/services/data/v67.0/sobjects/' + apiName, new Map<String, Object>{
                'get' => new Map<String, Object>{
                    'summary' => 'List or Describe ' + label,
                    'operationId' => 'describe_' + apiName
                },
                'post' => new Map<String, Object>{
                    'summary' => 'Create ' + label + ' Record',
                    'operationId' => 'create_' + apiName
                }
            });

            pathsMap.put('/services/data/v67.0/sobjects/' + apiName + '/{recordId}', new Map<String, Object>{
                'get' => new Map<String, Object>{
                    'summary' => 'Retrieve ' + label + ' Record',
                    'operationId' => 'get_' + apiName
                },
                'patch' => new Map<String, Object>{
                    'summary' => 'Update ' + label + ' Record',
                    'operationId' => 'update_' + apiName
                },
                'delete' => new Map<String, Object>{
                    'summary' => 'Delete ' + label + ' Record',
                    'operationId' => 'delete_' + apiName
                }
            });

            Map<String, Object> fieldProps = new Map<String, Object>();
            for (Schema.SObjectField f : d.fields.getMap().values()) {
                Schema.DescribeFieldResult fd = f.getDescribe();
                fieldProps.put(fd.getName(), new Map<String, Object>{
                    'type' => String.valueOf(fd.getType()).toLowerCase(),
                    'title' => fd.getLabel(),
                    'nullable' => fd.isNillable()
                });
            }

            schemasMap.put(apiName, new Map<String, Object>{
                'type' => 'object',
                'title' => label,
                'properties' => fieldProps
            });
        }

        return JSON.serializePretty(spec);
    }

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
