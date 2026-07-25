@isTest
private class MCPAutoRegisterInstallerTest {

    @isTest
    static void testPostInstallScript() {
        Test.startTest();
        MCPAutoRegisterInstaller installer = new MCPAutoRegisterInstaller();
        Test.testInstall(installer, new Version(1, 0), false);
        Test.stopTest();

        MCP_Config__c config = MCP_Config__c.getOrgDefaults();
        System.assertNotEquals(null, config, 'MCP_Config__c should be created on post-install.');
        System.assert(config.MCP_Server_URL__c.contains('/services/mcp/v1.0/headless360'), 'URL should contain headless360 endpoint');
        System.assertEquals('Active - Registered', config.Status__c);
    }
}
