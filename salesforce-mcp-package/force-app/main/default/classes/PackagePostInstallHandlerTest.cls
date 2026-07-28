@isTest
private class PackagePostInstallHandlerTest {

    @isTest
    static void testPackagePostInstallHandler_Execution() {
        Test.startTest();
        PackagePostInstallHandler handler = new PackagePostInstallHandler();
        Test.testInstall(handler, null);
        Test.stopTest();

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        System.assertNotEquals(null, config, 'Messaging_Config__c org defaults should not be null after install');
        System.assertEquals('ALL', config.Selected_Messaging_Channel_Id__c, 'Default channel filter should be ALL');
        System.assertEquals('agent', config.Agent_Keyword__c, 'Default agent keyword should be agent');
    }

    @isTest
    static void testInitializeOrgDefaults_DirectCall() {
        Test.startTest();
        PackagePostInstallHandler.initializeOrgDefaults();
        PackagePostInstallHandler.assignAdminPermissionSet();
        Test.stopTest();

        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        System.assertNotEquals(null, config, 'Config should be initialized');
    }
}
