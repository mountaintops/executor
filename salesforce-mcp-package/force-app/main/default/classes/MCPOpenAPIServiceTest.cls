@isTest
private class MCPOpenAPIServiceTest {

    private class MockHttpResponseGenerator implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setBody('{"locator":"08cg00000000test","status":"InProgress"}');
            res.setStatusCode(200);
            return res;
        }
    }

    @isTest
    static void testGetOpenApiSpecRest() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/openapi/';
        req.httpMethod = 'GET';
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPOpenAPIService.getOpenApiSpec();
        Test.stopTest();

        System.assertEquals(200, res.statusCode);
        System.assert(res.responseBody.toString().contains('openapi'), 'Response should contain openapi spec key');
    }

    @isTest
    static void testGenerateOpenApiSpecJson() {
        String jsonSpec = MCPOpenAPIService.generateOpenApiSpecJson();
        System.assertNotEquals(null, jsonSpec);
        System.assert(jsonSpec.contains('3.0.3'));
    }

    @isTest
    static void testTriggerSalesforceOas3GenerationAsync() {
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());

        Test.startTest();
        MCPOpenAPIService.triggerSalesforceOas3GenerationAsync('SESSION_TEST_TOKEN');
        Test.stopTest();
    }
}
