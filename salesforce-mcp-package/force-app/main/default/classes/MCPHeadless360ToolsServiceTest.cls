@isTest
private class MCPHeadless360ToolsServiceTest {
    @isTest
    static void testHandleMcpRequestInitialize() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/headless360/';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
        
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPHeadless360ToolsService.handleMcpRequest();
        Test.stopTest();

        System.assertEquals(200, res.statusCode);
        System.assert(res.responseBody.toString().contains('Salesforce Headless 360 MCP Server'));
    }

    @isTest
    static void testHandleMcpRequestToolsList() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/headless360/';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
        
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPHeadless360ToolsService.handleMcpRequest();
        Test.stopTest();

        System.assertEquals(200, res.statusCode);
        System.assert(res.responseBody.toString().contains('discover'));
        System.assert(res.responseBody.toString().contains('describe'));
        System.assert(res.responseBody.toString().contains('dispatch'));
    }

    @isTest
    static void testHandleMcpRequestToolsCallDiscover() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/headless360/';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"discover","arguments":{"intent":"list accounts"}}}');
        
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPHeadless360ToolsService.handleMcpRequest();
        Test.stopTest();

        System.assertEquals(200, res.statusCode);
        System.assert(res.responseBody.toString().contains('op_list_accounts'));
    }

    @isTest
    static void testHandleMcpGet() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/headless360/';
        req.httpMethod = 'GET';
        
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPHeadless360ToolsService.handleMcpGet();
        Test.stopTest();

        System.assertEquals(200, res.statusCode);
        System.assert(res.responseBody.toString().contains('soql_query'));
    }
}
