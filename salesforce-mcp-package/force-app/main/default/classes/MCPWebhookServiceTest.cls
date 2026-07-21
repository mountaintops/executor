@isTest
private class MCPWebhookServiceTest {

    private class MockHttpResponseGenerator implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setBody('{"status":"received","message":"Cloudflare Executor logged payload successfully"}');
            res.setStatusCode(200);
            return res;
        }
    }

    @isTest
    static void testSendRegistrationWebhook() {
        Test.setMock(HttpCalloutMock.class, new MockHttpResponseGenerator());

        Test.startTest();
        MCPWebhookService.sendRegistrationWebhook(
            'https://test.my.salesforce.com/services/mcp/v1.0/headless360',
            'SFDC_CLIENT_TEST_123',
            'sec_test_secret_456',
            'Active - Registered',
            UserInfo.getOrganizationId(),
            'https://executor-cloudflare.emalteaproductions.workers.dev/webhook'
        );
        Test.stopTest();
    }
}
