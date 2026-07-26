@isTest
private class TopNotificationControllerTest {

    @isTest
    static void testSaveAndActivateNotificationGlobal() {
        Map<String, Object> payload = new Map<String, Object>{
            'title' => 'Test Global Announcement',
            'message' => 'System maintenance planned for midnight.',
            'theme' => 'warning',
            'isGlobal' => true,
            'isDismissible' => true
        };

        Test.startTest();
        Map<String, Object> result = TopNotificationController.saveAndActivateNotification(payload);
        Test.stopTest();

        System.assertEquals(true, result.get('success'), 'Save and activate should return success');
        String recordId = (String) result.get('recordId');
        System.assert(String.isNotBlank(recordId), 'Record ID should not be blank');

        Notification_Broadcast__c rec = [SELECT Id, Title__c, Is_Active__c, Is_Global__c FROM Notification_Broadcast__c WHERE Id = :recordId];
        System.assertEquals('Test Global Announcement', rec.Title__c);
        System.assertEquals(true, rec.Is_Active__c);
        System.assertEquals(true, rec.Is_Global__c);

        // Test getActiveNotificationForCurrentUser
        Map<String, Object> activeRes = TopNotificationController.getActiveNotificationForCurrentUser();
        System.assertEquals(true, activeRes.get('hasNotification'), 'Should have active notification');

        // Test diagnostics
        Map<String, Object> diag = TopNotificationController.getDiagnostics();
        System.assertNotEquals(null, diag.get('userId'));
    }

    @isTest
    static void testTargetedNotificationUserMatching() {
        Id currentUserId = UserInfo.getUserId();

        Map<String, Object> payload = new Map<String, Object>{
            'title' => 'Targeted User Notice',
            'message' => 'Direct user message.',
            'theme' => 'info',
            'isGlobal' => false,
            'isDismissible' => true,
            'targetUserIds' => String.valueOf(currentUserId)
        };

        Test.startTest();
        Map<String, Object> result = TopNotificationController.saveAndActivateNotification(payload);
        Test.stopTest();

        System.assertEquals(true, result.get('success'));
        String recordId = (String) result.get('recordId');

        Boolean isTargeted = TopNotificationController.isCurrentUserTargetedByRecord(recordId);
        System.assertEquals(true, isTargeted, 'Current user should be targeted');
    }

    @isTest
    static void testDeactivateNotification() {
        Map<String, Object> payload = new Map<String, Object>{
            'title' => 'Temporary Notice',
            'message' => 'To be deactivated.',
            'theme' => 'info',
            'isGlobal' => true,
            'isDismissible' => true
        };

        Map<String, Object> saveResult = TopNotificationController.saveAndActivateNotification(payload);
        String recordId = (String) saveResult.get('recordId');

        Test.startTest();
        Map<String, Object> deactResult = TopNotificationController.deactivateNotification(recordId);
        Test.stopTest();

        System.assertEquals(true, deactResult.get('success'));

        Notification_Broadcast__c rec = [SELECT Id, Is_Active__c FROM Notification_Broadcast__c WHERE Id = :recordId];
        System.assertEquals(false, rec.Is_Active__c);
    }

    @isTest
    static void testGetAdminOptionsAndGetAllBroadcasts() {
        Test.startTest();
        Map<String, Object> options = TopNotificationController.getAdminOptions();
        List<Notification_Broadcast__c> broadcasts = TopNotificationController.getAllBroadcasts();
        Map<String, Object> agentConfig = TopNotificationController.getAgentNotificationConfig();
        
        Map<String, Object> savePayload = new Map<String, Object>{
            'agentKeyword' => 'human',
            'isGlobal' => false,
            'autoQueueDetector' => true,
            'detectJoinedAgent' => true,
            'useFlowRouting' => true,
            'selectedMessagingChannelId' => 'ALL'
        };
        Map<String, Object> saveRes = TopNotificationController.saveAgentNotificationConfig(savePayload);
        Map<String, Object> simRes = TopNotificationController.getSimulatedAgentTargetingDetails();
        Map<String, Object> sysDetRes = TopNotificationController.getRealSystemDetections();
        Test.stopTest();

        System.assertNotEquals(null, options);
        System.assertNotEquals(null, broadcasts);
        System.assertNotEquals(null, agentConfig);
        System.assertNotEquals(null, simRes);
        System.assertNotEquals(null, sysDetRes);
        System.assertEquals(true, saveRes.get('success'));
        System.assertEquals(true, sysDetRes.get('success'));
    }
}


