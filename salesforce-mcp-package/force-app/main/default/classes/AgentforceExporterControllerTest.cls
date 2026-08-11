/**
 * @description Unit Test Class for AgentforceExporterController.
 */
@IsTest
public class AgentforceExporterControllerTest {

    private class ToolingApiMock implements HttpCalloutMock {
        public HTTPResponse respond(HTTPRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');

            String endpoint = req.getEndpoint();
            if (endpoint.contains('BotDefinition')) {
                res.setBody('{"records":[{"Id":"0Xxg00000000001","DeveloperName":"Test","MasterLabel":"Test"}]}');
            } else if (endpoint.contains('AiAuthoringBundle')) {
                res.setBody('{"records":[{"Id":"1bZg00000000001","DeveloperName":"Test_1","MasterLabel":"Test_1"}]}');
            } else if (endpoint.contains('GenAiPlannerBundle')) {
                res.setBody('{"records":[{"Id":"16jg00000000001","DeveloperName":"Test_v1","MasterLabel":"Test"}]}');
            } else if (endpoint.contains('GenAiPluginDefinition')) {
                res.setBody('{"records":[{"Id":"179g00000000001","DeveloperName":"escalation_16jg","MasterLabel":"Escalation","Description":"Escalation subagent"}]}');
            } else if (endpoint.contains('GenAiPluginInstructionDef')) {
                res.setBody('{"records":[{"Id":"1C7g00000000001","DeveloperName":"instruction0","MasterLabel":"Instruction 0","Description":"You are an AI agent."}]}');
            } else if (endpoint.contains('GenAiFunctionDefinition')) {
                res.setBody('{"records":[{"Id":"172g00000000001","DeveloperName":"AnswerQuestionsWithKnowledge","MasterLabel":"Answer Questions"}]}');
            } else if (endpoint.contains('McpServerDefinition')) {
                res.setBody('{"records":[{"Id":"1g1g00000000001","DeveloperName":"TEST","MasterLabel":"TEST"}]}');
            } else if (endpoint.contains('/einstein/data-libraries/1JDgTest')) {
                res.setBody('{"libraryId":"1JDgTest","developerName":"sdfg","masterLabel":"sdfg","sourceType":"SFDRIVE","status":"READY","retrieverLabel":"File_sdfg","retrieverId":"1CxgTest","groundingSource":{"groundingSourceType":"SFDRIVE","indexMode":"ENHANCED","totalFileCount":1,"groundingFileRefs":[{"fileId":"1JcgTest","fileName":"surrealsystems235.txt","filePath":"$agentforce_data_library$/1JDgTest/surrealsystems235.txt","fileSize":8023.0,"status":"INDEXED","createdBy":"Ivan Jaimes","createdDate":"Fri Aug 07 20:44:42 GMT 2026"}]}}');
            } else if (endpoint.contains('/einstein/data-libraries')) {
                res.setBody('{"libraries":[{"libraryId":"1JDgTest","developerName":"sdfg","masterLabel":"sdfg","sourceType":"SFDRIVE","status":"READY"}],"totalSize":1}');
            } else {
                res.setBody('{"records":[]}');
            }
            return res;
        }
    }

    @IsTest
    static void testExportAgentSuccess() {
        Test.setMock(HttpCalloutMock.class, new ToolingApiMock());

        Messaging_Config__c config = new Messaging_Config__c(
            Agent_Keyword__c = 'agent',
            Confirmation_Text__c = 'transmited notification',
            Reactivation_Keyword__c = 'reset'
        );
        insert config;

        Test.startTest();
        Map<String, Object> result = AgentforceExporterController.exportAgent('Test');
        Test.stopTest();

        System.assertEquals(true, result.get('success'), 'Export should succeed');
        System.assert(result.get('data') != null, 'Data payload should not be null');

        Map<String, Object> data = (Map<String, Object>) result.get('data');
        System.assertEquals('Test', data.get('targetAgentName'));
        System.assert(data.get('bots') != null, 'bots should not be null');
        System.assert(data.get('subagents') != null, 'subagents should not be null');
        System.assert(data.get('subagentInstructions') != null, 'subagentInstructions should not be null');
        System.assert(data.get('functions') != null, 'functions should not be null');
        System.assert(data.get('escalationSettings') != null, 'escalationSettings should not be null');
        System.assert(data.get('dataLibrary') != null, 'dataLibrary should not be null');

        Map<String, Object> dataLib = (Map<String, Object>) data.get('dataLibrary');
        System.assert(dataLib.get('einsteinDataLibraries') != null, 'einsteinDataLibraries should not be null');
        System.assert(dataLib.get('sfDriveFiles') != null, 'sfDriveFiles should not be null');
    }

    @IsTest
    static void testExportAgentforceZip() {
        Test.setMock(HttpCalloutMock.class, new ToolingApiMock());

        Test.startTest();
        Map<String, Object> zipResult = AgentforceExporterController.exportAgentforceZip('Test');
        Test.stopTest();

        System.assertEquals(true, zipResult.get('success'), 'ZIP export should succeed');
        System.assert(zipResult.get('zipBase64') != null, 'ZIP base64 should not be null');
    }

    @IsTest
    static void testExportAllAgents() {
        Test.setMock(HttpCalloutMock.class, new ToolingApiMock());

        Test.startTest();
        Map<String, Object> result = AgentforceExporterController.exportAllAgents();
        Test.stopTest();

        System.assertEquals(true, result.get('success'), 'Export all should succeed');
    }

    @IsTest
    static void testDoGetRestEndpoint() {
        Test.setMock(HttpCalloutMock.class, new ToolingApiMock());

        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/AgentforceExporter';
        req.httpMethod = 'GET';
        req.addParameter('agent', 'Test');

        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        AgentforceExporterController.doGet();
        Test.stopTest();

        System.assert(res.responseBody != null, 'Response body should contain JSON output');
    }

    @IsTest
    static void testDoGetRestZipEndpoint() {
        Test.setMock(HttpCalloutMock.class, new ToolingApiMock());

        RestRequest req = new RestRequest();
        RestResponse res = new RestResponse();
        req.requestURI = '/services/apexrest/AgentforceExporter';
        req.httpMethod = 'GET';
        req.addParameter('agent', 'Test');
        req.addParameter('format', 'zip');

        RestContext.request = req;
        RestContext.response = res;

        Test.startTest();
        AgentforceExporterController.doGet();
        Test.stopTest();

        System.assert(res.responseBody != null, 'Response body should contain ZIP binary');
    }

    @IsTest
    static void testGetApiSessionId() {
        String token = AgentforceExporterController.getApiSessionId();
        System.assert(token != null, 'Session token should not be null');
    }
}
