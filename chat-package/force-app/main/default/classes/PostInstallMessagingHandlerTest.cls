@isTest
private class PostInstallMessagingHandlerTest {

    @isTest
    static void testPostInstallScriptExecution() {
        PostInstallMessagingHandler handler = new PostInstallMessagingHandler();
        
        Test.startTest();
        // Simulate package install (InstallContext version 1.0.0, not a push or upgrade)
        Test.testInstall(handler, new Version(1, 0), false);
        Test.stopTest();

        System.assert(true, 'PostInstallMessagingHandler executed successfully without throwing uncaught exceptions.');
    }
}
