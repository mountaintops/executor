/**
 * @description Unit tests for MCPOmniChannelMessageDispatcher Invocable Action in salesforce-mcp-package.
 */
@IsTest
private class MCPOmniChannelMessageDispatcherTest {

    @IsTest
    static void testPrimaryPathGreetingSuccess() {
        // Create mock record ID (MessagingSession format prefix '0Mw')
        Id fakeSessionId = '0Mw000000000001AAA';

        MCPOmniChannelMessageDispatcher.MessagingRequest req = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req.recordId = fakeSessionId;
        req.messageChoice = 'Greeting';
        req.serviceChannel = 'sfdc_livemessage';
        req.simulateFailure = false;

        Test.startTest();
        List<MCPOmniChannelMessageDispatcher.MessagingResult> results = MCPOmniChannelMessageDispatcher.dispatchSystemMessage(
            new List<MCPOmniChannelMessageDispatcher.MessagingRequest>{ req }
        );
        Test.stopTest();

        System.assertNotEquals(null, results, 'Results should not be null');
        System.assertEquals(1, results.size(), 'Should return 1 result');
        System.assertEquals(true, results[0].success, 'Success flag should be true');
        System.assertEquals(fakeSessionId, results[0].recordId, 'Record ID should match');
        System.assert(results[0].dispatchedMessage.contains('Thank you for contacting customer support'), 'Should resolve Greeting text');
    }

    @IsTest
    static void testPredefinedMessageChoices() {
        Id fakeSessionId = '0Mw000000000002AAA';

        MCPOmniChannelMessageDispatcher.MessagingRequest req1 = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req1.recordId = fakeSessionId;
        req1.messageChoice = 'System Maintenance Notice';

        MCPOmniChannelMessageDispatcher.MessagingRequest req2 = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req2.recordId = fakeSessionId;
        req2.messageChoice = 'Queue Delay Warning';

        MCPOmniChannelMessageDispatcher.MessagingRequest req3 = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req3.recordId = fakeSessionId;
        req3.messageChoice = 'Custom system text payload';

        Test.startTest();
        List<MCPOmniChannelMessageDispatcher.MessagingResult> results = MCPOmniChannelMessageDispatcher.dispatchSystemMessage(
            new List<MCPOmniChannelMessageDispatcher.MessagingRequest>{ req1, req2, req3 }
        );
        Test.stopTest();

        System.assertEquals(3, results.size(), 'Should process all 3 requests');
        System.assert(results[0].dispatchedMessage.contains('scheduled maintenance'), 'Should match maintenance text');
        System.assert(results[1].dispatchedMessage.contains('High inquiry volume'), 'Should match queue delay text');
        System.assertEquals('Custom system text payload', results[2].dispatchedMessage, 'Should echo custom payload');
    }

    @IsTest
    static void testSimulatedFailureFaultPath() {
        Id fakeSessionId = '0Mw000000000003AAA';

        MCPOmniChannelMessageDispatcher.MessagingRequest req = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req.recordId = fakeSessionId;
        req.messageChoice = 'Greeting';
        req.simulateFailure = true;

        Boolean exceptionCaught = false;
        String errorMessage = '';

        Test.startTest();
        try {
            MCPOmniChannelMessageDispatcher.dispatchSystemMessage(
                new List<MCPOmniChannelMessageDispatcher.MessagingRequest>{ req }
            );
        } catch (MCPOmniChannelMessageDispatcher.OmniChannelMessagingException ex) {
            exceptionCaught = true;
            errorMessage = ex.getMessage();
        }
        Test.stopTest();

        System.assertEquals(true, exceptionCaught, 'Should throw OmniChannelMessagingException on simulateFailure');
        System.assertEquals('Simulated Message Delivery Failure', errorMessage, 'Error message should match simulation text');
    }

    @IsTest
    static void testNullRecordIdThrowsException() {
        MCPOmniChannelMessageDispatcher.MessagingRequest req = new MCPOmniChannelMessageDispatcher.MessagingRequest();
        req.recordId = null;
        req.messageChoice = 'Greeting';

        Boolean exceptionCaught = false;

        Test.startTest();
        try {
            MCPOmniChannelMessageDispatcher.dispatchSystemMessage(
                new List<MCPOmniChannelMessageDispatcher.MessagingRequest>{ req }
            );
        } catch (MCPOmniChannelMessageDispatcher.OmniChannelMessagingException ex) {
            exceptionCaught = true;
        }
        Test.stopTest();

        System.assertEquals(true, exceptionCaught, 'Null recordId should throw OmniChannelMessagingException for Fault Path');
    }
}
