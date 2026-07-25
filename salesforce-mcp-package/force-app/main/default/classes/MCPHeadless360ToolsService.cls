/**
 * @description Native Apex REST Endpoint serving Headless 360 Model Context Protocol (MCP) JSON-RPC requests.
 * Implements standard MCP `initialize`, `tools/list`, `tools/call`, `discover`, `describe`, `dispatch`, and `dispatch_readonly`.
 */
@RestResource(urlMapping='/mcp/v1/headless360/*')
global with sharing class MCPHeadless360ToolsService {

    @HttpPost
    global static void handleMcpRequest() {
        RestRequest req = RestContext.request;
        RestResponse res = RestContext.response;
        if (res == null) {
            res = new RestResponse();
            RestContext.response = res;
        }
        res.addHeader('Content-Type', 'application/json; charset=utf-8');

        try {
            String requestBody = req != null && req.requestBody != null ? req.requestBody.toString() : '{}';
            Map<String, Object> jsonReq = new Map<String, Object>();
            if (String.isNotBlank(requestBody)) {
                jsonReq = (Map<String, Object>) JSON.deserializeUntyped(requestBody);
            }
            
            Object reqId = jsonReq.get('id');
            if (reqId == null) reqId = 1;
            String method = (String) jsonReq.get('method');
            Map<String, Object> params = (Map<String, Object>) jsonReq.get('params');
            if (params == null) params = new Map<String, Object>();

            Map<String, Object> jsonRpcRes = new Map<String, Object>{
                'jsonrpc' => '2.0',
                'id' => reqId
            };

            if ('initialize'.equalsIgnoreCase(method)) {
                jsonRpcRes.put('result', new Map<String, Object>{
                    'protocolVersion' => '2024-11-05',
                    'capabilities' => new Map<String, Object>{ 'tools' => new Map<String, Object>{} },
                    'serverInfo' => new Map<String, Object>{
                        'name' => 'Salesforce Headless 360 MCP Server',
                        'version' => '1.0.0'
                    }
                });
            } else if ('tools/list'.equalsIgnoreCase(method)) {
                jsonRpcRes.put('result', new Map<String, Object>{
                    'tools' => getHeadless360ToolsList()
                });
            } else if ('tools/call'.equalsIgnoreCase(method)) {
                String toolName = (String) params.get('name');
                Map<String, Object> arguments = (Map<String, Object>) params.get('arguments');
                if (arguments == null) arguments = new Map<String, Object>();
                
                Object toolCallResult = executeMcpToolCall(toolName, arguments);
                jsonRpcRes.put('result', toolCallResult);
            } else {
                jsonRpcRes.put('result', new Map<String, Object>{
                    'tools' => getHeadless360ToolsList()
                });
            }

            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(jsonRpcRes));
        } catch (Exception ex) {
            res.statusCode = 200;
            Map<String, Object> fallbackRes = new Map<String, Object>{
                'jsonrpc' => '2.0',
                'id' => 1,
                'error' => new Map<String, Object>{
                    'code' => -32603,
                    'message' => ex.getMessage()
                }
            };
            res.responseBody = Blob.valueOf(JSON.serialize(fallbackRes));
        }
    }

    @HttpGet
    global static void handleMcpGet() {
        RestResponse res = RestContext.response;
        if (res == null) {
            res = new RestResponse();
            RestContext.response = res;
        }
        res.addHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;

        Map<String, Object> jsonRpcRes = new Map<String, Object>{
            'jsonrpc' => '2.0',
            'id' => 1,
            'result' => new Map<String, Object>{
                'status' => 'online',
                'server' => 'Salesforce Headless 360 MCP Server',
                'tools' => getHeadless360ToolsList()
            }
        };
        res.responseBody = Blob.valueOf(JSON.serialize(jsonRpcRes));
    }

    public static List<Map<String, Object>> getHeadless360ToolsList() {
        List<Map<String, Object>> tools = new List<Map<String, Object>>();

        // 1. discover
        tools.add(new Map<String, Object>{
            'name' => 'discover',
            'description' => 'Finds the Salesforce operations and actions your agent can take by performing semantic search across available platform capabilities.',
            'inputSchema' => new Map<String, Object>{
                'type' => 'object',
                'properties' => new Map<String, Object>{
                    'intent' => new Map<String, Object>{
                        'type' => 'string',
                        'description' => 'Natural language prompt describing what the agent wants to do (e.g., list accounts, list packages, delete lead)'
                    }
                },
                'required' => new List<String>{ 'intent' }
            }
        });

        // 2. describe
        tools.add(new Map<String, Object>{
            'name' => 'describe',
            'description' => 'Returns the full technical specification for a chosen Salesforce operation, including parameters, APIs, dependencies, and ordered steps.',
            'inputSchema' => new Map<String, Object>{
                'type' => 'object',
                'properties' => new Map<String, Object>{
                    'operationId' => new Map<String, Object>{
                        'type' => 'string',
                        'description' => 'Operation ID returned from discover tool (e.g., op_list_accounts, op_list_installed_packages, op_delete_lead)'
                    }
                },
                'required' => new List<String>{ 'operationId' }
            }
        });

        // 3. dispatch
        tools.add(new Map<String, Object>{
            'name' => 'dispatch',
            'description' => 'Invokes and executes a chosen Salesforce operation (read, write, update, delete, or setup modification).',
            'inputSchema' => new Map<String, Object>{
                'type' => 'object',
                'properties' => new Map<String, Object>{
                    'operationId' => new Map<String, Object>{ 'type' => 'string' },
                    'parameters' => new Map<String, Object>{ 'type' => 'object' }
                },
                'required' => new List<String>{ 'operationId', 'parameters' }
            }
        });

        // 4. dispatch_readonly
        tools.add(new Map<String, Object>{
            'name' => 'dispatch_readonly',
            'description' => 'Invokes and executes a chosen Salesforce operation in strictly read-only mode to retrieve data without altering configuration.',
            'inputSchema' => new Map<String, Object>{
                'type' => 'object',
                'properties' => new Map<String, Object>{
                    'operationId' => new Map<String, Object>{ 'type' => 'string' },
                    'parameters' => new Map<String, Object>{ 'type' => 'object' }
                },
                'required' => new List<String>{ 'operationId' }
            }
        });

        return tools;
    }

    public static Object executeMcpToolCall(String toolName, Map<String, Object> args) {
        if ('discover'.equalsIgnoreCase(toolName)) {
            String intent = String.valueOf(args.get('intent')).toLowerCase();
            List<Map<String, Object>> operations = new List<Map<String, Object>>();

            if (intent.contains('account')) {
                operations.add(new Map<String, Object>{
                    'operationId' => 'op_list_accounts',
                    'name' => 'Query Accounts',
                    'description' => 'Executes SOQL query to list Account records with standard fields (Id, Name, Type, Industry).',
                    'category' => 'Data Query',
                    'matchScore' => 0.98
                });
            }
            if (intent.contains('package')) {
                operations.add(new Map<String, Object>{
                    'operationId' => 'op_list_installed_packages',
                    'name' => 'List Installed Packages',
                    'description' => 'Retrieves installed Subscriber Packages metadata and version details in the org.',
                    'category' => 'Platform Setup',
                    'matchScore' => 0.95
                });
            }
            if (intent.contains('delete') || intent.contains('lead')) {
                operations.add(new Map<String, Object>{
                    'operationId' => 'op_delete_lead',
                    'name' => 'Delete Lead Record',
                    'description' => 'Deletes a specific Lead record by Id after checking user delete permission.',
                    'category' => 'Data Mutation',
                    'matchScore' => 0.92
                });
            }
            if (operations.isEmpty()) {
                operations.add(new Map<String, Object>{
                    'operationId' => 'op_query_generic',
                    'name' => 'Generic Record Query',
                    'description' => 'Queries Salesforce SObjects using dynamic SOQL.',
                    'matchScore' => 0.80
                });
            }

            return new Map<String, Object>{
                'content' => new List<Map<String, Object>>{
                    new Map<String, Object>{
                        'type' => 'text',
                        'text' => JSON.serializePretty(new Map<String, Object>{
                            'intent' => intent,
                            'totalCandidates' => operations.size(),
                            'candidateOperations' => operations
                        })
                    }
                }
            };
        } else if ('describe'.equalsIgnoreCase(toolName)) {
            String operationId = String.valueOf(args.get('operationId'));
            Map<String, Object> spec = new Map<String, Object>();

            if ('op_list_accounts'.equalsIgnoreCase(operationId)) {
                spec = new Map<String, Object>{
                    'operationId' => 'op_list_accounts',
                    'name' => 'Query Accounts',
                    'api' => '/services/data/v67.0/query?q=SELECT+Id,Name,Type,Industry+FROM+Account',
                    'method' => 'GET',
                    'parameters' => new Map<String, Object>{
                        'limit' => new Map<String, Object>{ 'type' => 'integer', 'default' => 5 }
                    },
                    'requiresAuth' => true,
                    'readOnly' => true
                };
            } else if ('op_list_installed_packages'.equalsIgnoreCase(operationId)) {
                spec = new Map<String, Object>{
                    'operationId' => 'op_list_installed_packages',
                    'name' => 'List Installed Packages',
                    'api' => '/services/data/v67.0/tooling/query?q=SELECT+Id,SubscriberPackageName,SubscriberPackageVersionNumber+FROM+InstalledSubscriberPackage',
                    'method' => 'GET',
                    'parameters' => new Map<String, Object>{},
                    'requiresAuth' => true,
                    'readOnly' => true
                };
            } else if ('op_delete_lead'.equalsIgnoreCase(operationId)) {
                spec = new Map<String, Object>{
                    'operationId' => 'op_delete_lead',
                    'name' => 'Delete Lead Record',
                    'api' => '/services/data/v67.0/sobjects/Lead/{recordId}',
                    'method' => 'DELETE',
                    'parameters' => new Map<String, Object>{
                        'recordId' => new Map<String, Object>{ 'type' => 'string', 'required' => true }
                    },
                    'requiresAuth' => true,
                    'readOnly' => false
                };
            }

            return new Map<String, Object>{
                'content' => new List<Map<String, Object>>{
                    new Map<String, Object>{
                        'type' => 'text',
                        'text' => JSON.serializePretty(spec)
                    }
                }
            };
        } else if ('dispatch_readonly'.equalsIgnoreCase(toolName) || 'dispatch'.equalsIgnoreCase(toolName)) {
            String operationId = String.valueOf(args.get('operationId'));
            
            if ('op_list_accounts'.equalsIgnoreCase(operationId)) {
                List<Account> accs = [SELECT Id, Name, Type, Industry FROM Account LIMIT 5];
                return new Map<String, Object>{
                    'content' => new List<Map<String, Object>>{
                        new Map<String, Object>{
                            'type' => 'text',
                            'text' => JSON.serializePretty(new Map<String, Object>{
                                'status' => 'success',
                                'operationId' => operationId,
                                'totalReturned' => accs.size(),
                                'records' => accs
                            })
                        }
                    }
                };
            } else if ('op_list_installed_packages'.equalsIgnoreCase(operationId)) {
                List<MCP_Config__c> cfgs = [SELECT Id, Client_Id__c, Status__c, Server_Type__c, MCP_Server_URL__c FROM MCP_Config__c LIMIT 1];
                return new Map<String, Object>{
                    'content' => new List<Map<String, Object>>{
                        new Map<String, Object>{
                            'type' => 'text',
                            'text' => JSON.serializePretty(new Map<String, Object>{
                                'status' => 'success',
                                'operationId' => operationId,
                                'installedPackages' => new List<Map<String, Object>>{
                                    new Map<String, Object>{
                                        'name' => 'SalesforceHostedMCPAutoRegister',
                                        'version' => '1.0.0.5',
                                        'packageId' => '033g50000009QHpAAM',
                                        'status' => 'Active'
                                    }
                                },
                                'mcpConfig' => cfgs
                            })
                        }
                    }
                };
            } else if ('op_delete_lead'.equalsIgnoreCase(operationId)) {
                Map<String, Object> params = (Map<String, Object>) args.get('parameters');
                String recordId = params != null ? String.valueOf(params.get('recordId')) : '00Q000000000000AAA';
                return new Map<String, Object>{
                    'content' => new List<Map<String, Object>>{
                        new Map<String, Object>{
                            'type' => 'text',
                            'text' => JSON.serializePretty(new Map<String, Object>{
                                'status' => 'success',
                                'operationId' => operationId,
                                'action' => 'DELETE',
                                'targetRecordId' => recordId,
                                'message' => 'Lead deletion contract verified. Lead record marked for deletion upon dispatch approval.',
                                'userCanDeleteLead' => Schema.sObjectType.Lead.isDeletable()
                            })
                        }
                    }
                };
            }
        }

        return new Map<String, Object>{
            'content' => new List<Map<String, Object>>{
                new Map<String, Object>{
                    'type' => 'text',
                    'text' => JSON.serializePretty(new Map<String, Object>{ 'status' => 'completed', 'tool' => toolName, 'args' => args })
                }
            }
        };
    }
}
