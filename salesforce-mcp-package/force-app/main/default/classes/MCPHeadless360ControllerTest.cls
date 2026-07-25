@isTest
private class MCPHeadless360ControllerTest {

    @isTest
    static void testGetMCPCredentialsRest() {
        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/mcp/v1/credentials/';
        req.httpMethod = 'GET';
        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        MCPHeadless360Controller.MCPCredentialsResponse response = MCPHeadless360Controller.getMCPCredentialsRest();
        Test.stopTest();

        System.assertNotEquals(null, response);
        System.assert(response.mcpServerUrl.contains('/services/mcp/v1.0/headless360'));
    }

    @isTest
    static void testRegisterOrUpdateMCP() {
        Test.startTest();
        MCPHeadless360Controller.MCPCredentialsResponse response = MCPHeadless360Controller.registerOrUpdateMCP(
            'https://test.my.salesforce.com/services/mcp/v1.0/headless360',
            'TEST_CLIENT_ID_123',
            'TEST_CLIENT_SECRET_456'
        );
        Test.stopTest();

        System.assertEquals('https://test.my.salesforce.com/services/mcp/v1.0/headless360', response.mcpServerUrl);
        System.assertEquals('TEST_CLIENT_ID_123', response.clientId);
        System.assertEquals('TEST_CLIENT_SECRET_456', response.clientSecret);
    }
}
