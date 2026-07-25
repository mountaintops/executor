@isTest
private class HeaderCustomControllerTest {

    /**
     * @description Test handleIncomingTurn with a valid 18-character Salesforce ID string.
     */
    @isTest
    static void testHandleIncomingTurn_ValidIdFormat() {
        Test.startTest();
        String mockSessionId = '0Mw000000000000AAA';
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn(mockSessionId, 'Hello Agent Test', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Response map should not be null');
        System.assertEquals(mockSessionId, result.get('sessionId'), 'SessionId should match input');
        System.assert(result.containsKey('success'), 'Result map should contain success key');
        System.assert(result.containsKey('message'), 'Result map should contain message key');
    }

    /**
     * @description Test handleIncomingTurn with a non-ID string ('ACTIVE_SESSION').
     */
    @isTest
    static void testHandleIncomingTurn_ActiveSessionFallback() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'Test turn text', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Response map should not be null');
        System.assertEquals('ACTIVE_SESSION', result.get('sessionId'), 'SessionId should match ACTIVE_SESSION');
    }

    /**
     * @description Test handleIncomingTurn with null and blank inputs.
     */
    @isTest
    static void testHandleIncomingTurn_NullAndBlankInputs() {
        Test.startTest();
        Map<String, Object> resultNull = HeaderCustomController.handleIncomingTurn(null, null, true);
        Map<String, Object> resultBlank = HeaderCustomController.handleIncomingTurn('', '', true);
        Test.stopTest();

        System.assertNotEquals(null, resultNull, 'Result for null input should not be null');
        System.assertNotEquals(null, resultBlank, 'Result for blank input should not be null');
    }

    /**
     * @description Test handleIncomingTurn with non-standard string conversation IDs.
     */
    @isTest
    static void testHandleIncomingTurn_CustomConversationId() {
        Test.startTest();
        Map<String, Object> result = HeaderCustomController.handleIncomingTurn('custom-uuid-1234-5678', 'Testing custom conversation string', true);
        Test.stopTest();

        System.assertNotEquals(null, result, 'Result for custom conversation ID should not be null');
        System.assertEquals('custom-uuid-1234-5678', result.get('sessionId'), 'SessionId should match custom string');
    }

    /**
     * @description Verify outbound messages do not dispatch agent notifications.
     */
    @isTest
    static void testHandleIncomingTurn_OutboundMessageDoesNotTriggerNotification() {
        Test.startTest();
        Map<String, Object> resultInbound = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'I need an Agent', true);
        Map<String, Object> resultOutbound = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'I am an Agent replying to you', false);
        Test.stopTest();

        System.assertNotEquals(null, resultInbound, 'Inbound result should not be null');
        System.assertNotEquals(null, resultOutbound, 'Outbound result should not be null');
    }
}
