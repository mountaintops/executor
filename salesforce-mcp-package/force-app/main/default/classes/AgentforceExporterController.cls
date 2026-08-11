/**
 * @description Enterprise Exporter Controller for Agentforce Agents, Subagents,
 * Escalation Flows, Einstein Data Libraries (SFDRIVE & CRM Content), Functions, and System Settings.
 * Supports JSON and Full ZIP Archive exports executable from Pure Apex, LWC Admin Panel, and SF CLI.
 */
@RestResource(urlMapping='/AgentforceExporter/*')
global with sharing class AgentforceExporterController {

    /**
     * @description REST GET Endpoint for external Web / Function / Plugin calls.
     * Example: GET /services/apexrest/AgentforceExporter?agent=Test&format=zip
     */
    @HttpGet
    global static void doGet() {
        RestRequest req = RestContext.request;
        RestResponse res = RestContext.response;

        String agentName = req != null && req.params != null && req.params.containsKey('agent')
            ? req.params.get('agent')
            : 'Test';

        String format = req != null && req.params != null && req.params.containsKey('format')
            ? req.params.get('format')
            : 'json';

        if (format == 'zip') {
            Map<String, Object> zipResult = exportAgentforceZip(agentName);
            res.addHeader('Content-Type', 'application/zip');
            res.addHeader('Content-Disposition', 'attachment; filename="Agentforce_' + agentName + '.zip"');
            res.responseBody = EncodingUtil.base64Decode((String) zipResult.get('zipBase64'));
        } else {
            res.addHeader('Content-Type', 'application/json');
            Map<String, Object> exportResult = exportAgent(agentName);
            res.responseBody = Blob.valueOf(JSON.serializePretty(exportResult));
        }
    }

    /**
     * @description Primary Pure Apex / LWC / CLI Exporter method returning full JSON manifest.
     */
    @AuraEnabled
    public static Map<String, Object> exportAgent(String agentName) {
        Map<String, Object> result = new Map<String, Object>();
        try {
            String targetName = String.isBlank(agentName) ? 'Test' : agentName.trim();
            String token = getApiSessionId();
            String baseUrl = Url.getOrgDomainUrl().toExternalForm();

            Map<String, Object> agentManifest = new Map<String, Object>();
            agentManifest.put('exportTimestamp', Datetime.now().format('yyyy-MM-dd HH:mm:ss'));
            agentManifest.put('targetAgentName', targetName);
            agentManifest.put('orgId', UserInfo.getOrganizationId());
            agentManifest.put('exportedBy', UserInfo.getUserName());

            // 1. Export Agent Definitions (Bot & BotVersion)
            List<Map<String, Object>> bots = exportBotDefinitions(baseUrl, token, targetName);
            agentManifest.put('bots', bots);

            // 2. Export AI Authoring Bundles
            List<Map<String, Object>> authoringBundles = exportAiAuthoringBundles(baseUrl, token, targetName);
            agentManifest.put('aiAuthoringBundles', authoringBundles);

            // 3. Export GenAi Planner Bundles / Reasoning Engines
            List<Map<String, Object>> planners = exportGenAiPlanners(baseUrl, token, targetName);
            agentManifest.put('genAiPlanners', planners);

            // 4. Export Subagents / Topics (GenAiPluginDefinition)
            List<Map<String, Object>> subagents = exportSubagents(baseUrl, token);
            agentManifest.put('subagents', subagents);

            // 5. Export Subagent Instructions (GenAiPluginInstructionDef)
            List<Map<String, Object>> instructions = exportSubagentInstructions(baseUrl, token);
            agentManifest.put('subagentInstructions', instructions);

            // 6. Export Actions / Functions (GenAiFunctionDefinition)
            List<Map<String, Object>> functions = exportFunctions(baseUrl, token);
            agentManifest.put('functions', functions);

            // 7. Export Escalation Flow Settings & Configurations
            Map<String, Object> escalationSettings = exportEscalationSettings();
            agentManifest.put('escalationSettings', escalationSettings);

            // 8. Export Data Library Documents (SFDRIVE Containers + CRM Content)
            Map<String, Object> dataLibrary = exportDataLibraryDocuments(baseUrl, token);
            agentManifest.put('dataLibrary', dataLibrary);

            // 9. Export MCP Server Definitions
            List<Map<String, Object>> mcpServers = exportMcpServers(baseUrl, token);
            agentManifest.put('mcpServers', mcpServers);

            List<Object> docs = (List<Object>) dataLibrary.get('documents');
            List<Object> sfDriveLibs = (List<Object>) dataLibrary.get('einsteinDataLibraries');
            List<Object> sfDriveFiles = (List<Object>) dataLibrary.get('sfDriveFiles');

            String summaryMsg = 'Successfully exported Agentforce Agent "' + targetName + '" with ' +
                subagents.size() + ' subagents, ' +
                instructions.size() + ' subagent instructions, ' +
                functions.size() + ' functions, ' +
                sfDriveLibs.size() + ' SFDRIVE Data Libraries (' + sfDriveFiles.size() + ' indexed files), ' +
                docs.size() + ' Content documents, and ' +
                ((List<Object>) escalationSettings.get('routingFlows')).size() + ' Escalation Routing Flows.';

            result.put('success', true);
            result.put('message', summaryMsg);
            result.put('data', agentManifest);

        } catch (Exception ex) {
            result.put('success', false);
            result.put('message', 'Error exporting Agentforce data: ' + ex.getMessage() + ' | Line: ' + ex.getLineNumber());
            System.debug('>>> [AgentforceExporterController:ERROR] ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }

        return result;
    }

    /**
     * @description Pure Apex ZIP Archive Exporter.
     * Bundles all agent JSON metadata, subagents, prompt instructions, actions,
     * escalation routing flows, SFDRIVE Data Libraries, and raw PDF/image documents into a single PKZip file.
     * Saves the ZIP to Salesforce ContentVersion and returns base64 + metadata.
     */
    @AuraEnabled
    public static Map<String, Object> exportAgentforceZip(String agentName) {
        String targetName = String.isBlank(agentName) ? 'Test' : agentName.trim();
        Map<String, Object> exportRaw = exportAgent(targetName);
        if (!(Boolean) exportRaw.get('success')) {
            return exportRaw;
        }
        Map<String, Object> manifest = (Map<String, Object>) exportRaw.get('data');
        return buildAgentforceZipFromManifest(targetName, manifest);
    }

    /**
     * @description Builds and inserts ZIP ContentVersion directly from pre-computed manifest.
     */
    @AuraEnabled
    public static Map<String, Object> buildAgentforceZipFromManifest(String targetName, Map<String, Object> manifest) {
        Map<String, Object> zipResult = new Map<String, Object>();
        try {
            AgentforceZipBuilder zip = new AgentforceZipBuilder();
            Integer totalFileCount = 0;

            // 1. Root Master Manifest JSON
            zip.addTextFile('manifest.json', JSON.serializePretty(manifest));
            totalFileCount++;

            // 2. Subagents / Topics
            List<Object> subagents = (List<Object>) manifest.get('subagents');
            if (subagents != null) {
                for (Object saObj : subagents) {
                    Map<String, Object> sa = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(saObj));
                    String filename = 'subagents/' + (String) sa.get('DeveloperName') + '.json';
                    zip.addTextFile(filename, JSON.serializePretty(sa));
                    totalFileCount++;
                }
            }

            // 3. Subagent Prompt Instructions
            List<Object> instructions = (List<Object>) manifest.get('subagentInstructions');
            if (instructions != null) {
                for (Object instrObj : instructions) {
                    Map<String, Object> instr = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(instrObj));
                    String filename = 'instructions/' + (String) instr.get('DeveloperName') + '.json';
                    zip.addTextFile(filename, JSON.serializePretty(instr));
                    totalFileCount++;
                }
            }

            // 4. Actions / Functions
            List<Object> functions = (List<Object>) manifest.get('functions');
            if (functions != null) {
                for (Object fnObj : functions) {
                    Map<String, Object> fn = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(fnObj));
                    String filename = 'functions/' + (String) fn.get('DeveloperName') + '.json';
                    zip.addTextFile(filename, JSON.serializePretty(fn));
                    totalFileCount++;
                }
            }

            // 5. Escalation & Routing Settings
            Map<String, Object> escalation = (Map<String, Object>) manifest.get('escalationSettings');
            if (escalation != null) {
                zip.addTextFile('escalation/escalation_settings.json', JSON.serializePretty(escalation));
                totalFileCount++;
            }

            // 6. Data Libraries (SFDRIVE containers & metadata)
            Map<String, Object> dataLib = (Map<String, Object>) manifest.get('dataLibrary');
            if (dataLib != null) {
                zip.addTextFile('datalibrary/sfdrive_manifest.json', JSON.serializePretty(dataLib));
                totalFileCount++;

                List<Object> sfDriveLibs = (List<Object>) dataLib.get('einsteinDataLibraries');
                if (sfDriveLibs != null) {
                    for (Object libObj : sfDriveLibs) {
                        Map<String, Object> l = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(libObj));
                        String lName = (String) l.get('developerName');
                        zip.addTextFile('datalibrary/libraries/' + lName + '.json', JSON.serializePretty(l));
                        totalFileCount++;
                    }
                }

                // 7. Binary / Text Files from ContentVersion
                List<Object> docs = (List<Object>) dataLib.get('documents');
                if (docs != null) {
                    for (Object docObj : docs) {
                        Map<String, Object> doc = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(docObj));
                        String b64 = (String) doc.get('base64Data');
                        String title = ((String) doc.get('title')).replace(' ', '_').replace('/', '_');
                        String ext = (String) doc.get('fileExtension');
                        String filename = 'datalibrary/files/' + title + '.' + ext;

                        if (String.isNotBlank(b64)) {
                            zip.addBinaryFile(filename, EncodingUtil.base64Decode(b64));
                            totalFileCount++;
                        }
                    }
                }
            }

            // Assemble binary ZIP Blob
            Blob zipBlob = zip.getZipArchive();
            String timestamp = Datetime.now().format('yyyyMMdd_HHmmss');
            String zipTitle = 'Agentforce_Export_' + targetName + '_' + timestamp;

            // Save ZIP to Salesforce Files (ContentVersion)
            ContentVersion cvZip = new ContentVersion();
            cvZip.Title = zipTitle;
            cvZip.PathOnClient = zipTitle + '.zip';
            cvZip.VersionData = zipBlob;
            cvZip.Description = 'Pure Apex Agentforce Export ZIP Bundle for Agent: ' + targetName;
            insert cvZip;

            zipResult.put('success', true);
            zipResult.put('message', 'Successfully generated Agentforce ZIP bundle with ' + totalFileCount + ' files.');
            zipResult.put('contentVersionId', cvZip.Id);
            zipResult.put('zipTitle', zipTitle);
            zipResult.put('zipSize', zipBlob.size());
            zipResult.put('totalFileCount', totalFileCount);
            zipResult.put('zipBase64', EncodingUtil.base64Encode(zipBlob));
            zipResult.put('downloadUrl', '/services/data/v64.0/sobjects/ContentVersion/' + cvZip.Id + '/VersionData');

        } catch (Exception ex) {
            zipResult.put('success', false);
            zipResult.put('message', 'Error creating Agentforce ZIP export: ' + ex.getMessage() + ' | Line: ' + ex.getLineNumber());
            System.debug('>>> [AgentforceExporterController:ZIP_ERROR] ' + ex.getMessage() + '\n' + ex.getStackTraceString());
        }

        return zipResult;
    }

    /**
     * @description Shortcut method to export all Agentforce data in org.
     */
    @AuraEnabled
    public static Map<String, Object> exportAllAgents() {
        return exportAgent('ALL');
    }

    // =========================================================================
    // PRIVATE EXPORTER HELPERS
    // =========================================================================

    private static List<Map<String, Object>> exportBotDefinitions(String baseUrl, String token, String targetName) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description, Type FROM BotDefinition';
            if (targetName != 'ALL') {
                query += ' WHERE DeveloperName = \'' + String.escapeSingleQuotes(targetName) + '\' OR MasterLabel = \'' + String.escapeSingleQuotes(targetName) + '\'';
            }
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportBotDefinitions note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportAiAuthoringBundles(String baseUrl, String token, String targetName) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description FROM AiAuthoringBundle';
            if (targetName != 'ALL') {
                query += ' WHERE DeveloperName LIKE \'' + String.escapeSingleQuotes(targetName) + '%\'';
            }
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportAiAuthoringBundles note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportGenAiPlanners(String baseUrl, String token, String targetName) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description, PlannerType FROM GenAiPlannerBundle';
            if (targetName != 'ALL') {
                query += ' WHERE DeveloperName LIKE \'' + String.escapeSingleQuotes(targetName) + '%\'';
            }
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportGenAiPlanners note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportSubagents(String baseUrl, String token) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description, Language FROM GenAiPluginDefinition';
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportSubagents note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportSubagentInstructions(String baseUrl, String token) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description, GenAiPluginDefinitionId FROM GenAiPluginInstructionDef';
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportSubagentInstructions note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportFunctions(String baseUrl, String token) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiFunctionDefinition';
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportFunctions note: ' + e.getMessage());
        }
        return listRes;
    }

    private static List<Map<String, Object>> exportMcpServers(String baseUrl, String token) {
        List<Map<String, Object>> listRes = new List<Map<String, Object>>();
        try {
            String query = 'SELECT Id, DeveloperName, MasterLabel, Description FROM McpServerDefinition';
            Map<String, Object> parsed = queryToolingApi(baseUrl, token, query);
            if (parsed.containsKey('records')) {
                for (Object item : (List<Object>) parsed.get('records')) {
                    Map<String, Object> rec = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(item));
                    rec.remove('attributes');
                    listRes.add(rec);
                }
            }
        } catch (Exception e) {
            System.debug('>>> exportMcpServers note: ' + e.getMessage());
        }
        return listRes;
    }

    private static Map<String, Object> exportEscalationSettings() {
        Map<String, Object> settings = new Map<String, Object>();

        // 1. Messaging Config org defaults
        Messaging_Config__c msgConfig = Messaging_Config__c.getOrgDefaults();
        settings.put('messagingConfig', msgConfig);

        // 2. Active Escalation & Routing Flows
        List<Map<String, Object>> flowViews = new List<Map<String, Object>>();
        try {
            List<FlowDefinitionView> flows = [
                SELECT Id, ApiName, Label, IsActive, ProcessType
                FROM FlowDefinitionView
                WHERE IsActive = true
                LIMIT 50
            ];
            for (FlowDefinitionView f : flows) {
                flowViews.add(new Map<String, Object>{
                    'id' => f.Id,
                    'apiName' => f.ApiName,
                    'label' => f.Label,
                    'isActive' => f.IsActive,
                    'processType' => f.ProcessType
                });
            }
        } catch (Exception e) {
            System.debug('>>> exportEscalationSettings flows note: ' + e.getMessage());
        }
        settings.put('routingFlows', flowViews);

        // 3. Messaging Channels
        List<Map<String, Object>> channels = new List<Map<String, Object>>();
        try {
            List<MessagingChannel> mcList = [SELECT Id, MasterLabel, DeveloperName, MessageType FROM MessagingChannel LIMIT 20];
            for (MessagingChannel mc : mcList) {
                channels.add(new Map<String, Object>{
                    'id' => mc.Id,
                    'masterLabel' => mc.MasterLabel,
                    'developerName' => mc.DeveloperName,
                    'messageType' => mc.MessageType
                });
            }
        } catch (Exception e) {
            System.debug('>>> exportEscalationSettings channels note: ' + e.getMessage());
        }
        settings.put('messagingChannels', channels);

        // 4. Queues & Routing Configurations
        List<Map<String, Object>> queues = new List<Map<String, Object>>();
        try {
            List<Group> grpList = [SELECT Id, Name, DeveloperName, QueueRoutingConfigId FROM Group WHERE Type = 'Queue' LIMIT 50];
            for (Group g : grpList) {
                queues.add(new Map<String, Object>{
                    'id' => g.Id,
                    'name' => g.Name,
                    'developerName' => g.DeveloperName,
                    'queueRoutingConfigId' => g.QueueRoutingConfigId
                });
            }
        } catch (Exception e) {
            System.debug('>>> exportEscalationSettings queues note: ' + e.getMessage());
        }
        settings.put('queues', queues);

        return settings;
    }

    /**
     * @description Dynamically exports both Einstein Data Libraries (SFDRIVE containers)
     * and Salesforce Files / CRM Content.
     */
    private static Map<String, Object> exportDataLibraryDocuments(String baseUrl, String token) {
        Map<String, Object> lib = new Map<String, Object>();
        List<Map<String, Object>> docs = new List<Map<String, Object>>();
        List<Map<String, Object>> einsteinLibs = new List<Map<String, Object>>();
        List<Map<String, Object>> sfDriveFiles = new List<Map<String, Object>>();

        // 1. Retrieve Einstein Data Libraries from /services/data/v67.0/einstein/data-libraries
        try {
            HttpRequest listReq = new HttpRequest();
            listReq.setEndpoint(baseUrl + '/services/data/v67.0/einstein/data-libraries');
            listReq.setMethod('GET');
            listReq.setHeader('Authorization', 'Bearer ' + token);
            listReq.setHeader('Content-Type', 'application/json');

            Http http = new Http();
            HttpResponse listRes = http.send(listReq);

            if (listRes.getStatusCode() == 200) {
                Map<String, Object> listJson = (Map<String, Object>) JSON.deserializeUntyped(listRes.getBody());
                List<Object> libs = (List<Object>) listJson.get('libraries');

                if (libs != null) {
                    for (Object lObj : libs) {
                        Map<String, Object> l = (Map<String, Object>) lObj;
                        String libId = (String) l.get('libraryId');

                        // Fetch detailed library and groundingFileRefs
                        HttpRequest detReq = new HttpRequest();
                        detReq.setEndpoint(baseUrl + '/services/data/v67.0/einstein/data-libraries/' + libId);
                        detReq.setMethod('GET');
                        detReq.setHeader('Authorization', 'Bearer ' + token);
                        detReq.setHeader('Content-Type', 'application/json');

                        HttpResponse detRes = http.send(detReq);
                        if (detRes.getStatusCode() == 200) {
                            Map<String, Object> detJson = (Map<String, Object>) JSON.deserializeUntyped(detRes.getBody());
                            einsteinLibs.add(detJson);

                            Map<String, Object> gs = (Map<String, Object>) detJson.get('groundingSource');
                            if (gs != null) {
                                List<Object> fRefs = (List<Object>) gs.get('groundingFileRefs');
                                if (fRefs != null) {
                                    for (Object fObj : fRefs) {
                                        Map<String, Object> f = (Map<String, Object>) fObj;
                                        f.put('libraryId', libId);
                                        f.put('libraryName', detJson.get('developerName'));
                                        f.put('libraryLabel', detJson.get('masterLabel'));
                                        f.put('retrieverLabel', detJson.get('retrieverLabel'));
                                        f.put('retrieverId', detJson.get('retrieverId'));
                                        sfDriveFiles.add(f);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            System.debug('>>> Einstein Data Libraries REST note: ' + e.getMessage());
        }

        // 2. Retrieve Salesforce Files / ContentVersion
        try {
            List<ContentVersion> cvList = [
                SELECT Id, ContentDocumentId, Title, FileType, FileExtension, ContentSize, Description, CreatedDate, LastModifiedDate
                FROM ContentVersion
                WHERE IsLatest = true 
                  AND FileType != 'ZIP' 
                  AND (NOT Title LIKE 'Agentforce_Export_%')
                ORDER BY CreatedDate DESC
                LIMIT 50
            ];

            for (ContentVersion cv : cvList) {
                String ext = String.isNotBlank(cv.FileExtension) 
                    ? cv.FileExtension 
                    : (cv.FileType != null ? cv.FileType.toLowerCase() : 'bin');

                String b64Data = null;
                try {
                    ContentVersion cvData = [SELECT VersionData FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];
                    if (cvData.VersionData != null) {
                        b64Data = EncodingUtil.base64Encode(cvData.VersionData);
                    }
                } catch (Exception e) {
                    System.debug('>>> Base64 encoding note for ' + cv.Id + ': ' + e.getMessage());
                }

                Map<String, Object> docMap = new Map<String, Object>{
                    'contentVersionId' => cv.Id,
                    'contentDocumentId' => cv.ContentDocumentId,
                    'title' => cv.Title,
                    'fileType' => cv.FileType,
                    'fileExtension' => ext,
                    'contentSize' => cv.ContentSize,
                    'description' => cv.Description,
                    'createdDate' => cv.CreatedDate,
                    'base64Data' => b64Data,
                    'downloadUrl' => '/services/data/v64.0/sobjects/ContentVersion/' + cv.Id + '/VersionData'
                };
                docs.add(docMap);
            }
        } catch (Exception e) {
            System.debug('>>> exportDataLibraryDocuments note: ' + e.getMessage());
        }

        lib.put('documents', docs);
        lib.put('einsteinDataLibraries', einsteinLibs);
        lib.put('sfDriveFiles', sfDriveFiles);
        lib.put('totalDocumentCount', docs.size() + sfDriveFiles.size());

        return lib;
    }

    private static Map<String, Object> queryToolingApi(String baseUrl, String token, String query) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(baseUrl + '/services/data/v64.0/tooling/query/?q=' + EncodingUtil.urlEncode(query, 'UTF-8'));
        req.setMethod('GET');
        req.setHeader('Authorization', 'Bearer ' + token);
        req.setHeader('Content-Type', 'application/json');

        Http http = new Http();
        HttpResponse res = http.send(req);

        if (res.getStatusCode() == 200) {
            return (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        } else {
            System.debug('>>> Tooling API Query returned status ' + res.getStatusCode() + ': ' + res.getBody());
            return new Map<String, Object>{ 'records' => new List<Object>() };
        }
    }

    public static String getApiSessionId() {
        try {
            PageReference pageRef = Page.GetSessionIdVF;
            String content = pageRef.getContent().toString();
            Integer startIdx = content.indexOf('SESSION_ID_START');
            Integer endIdx = content.indexOf('SESSION_ID_END');
            if (startIdx != -1 && endIdx != -1) {
                String liveSessionId = content.substring(startIdx + 16, endIdx).trim();
                if (String.isNotBlank(liveSessionId)) {
                    return liveSessionId;
                }
            }
        } catch (Exception e) {
            System.debug('>>> [AgentforceExporterController] Visualforce SessionId note: ' + e.getMessage());
        }
        
        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config != null && String.isNotBlank(config.Api_Token__c)) {
            return config.Api_Token__c;
        }

        return UserInfo.getSessionId();
    }
}
