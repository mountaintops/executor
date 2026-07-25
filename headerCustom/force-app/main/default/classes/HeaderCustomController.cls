public without sharing class HeaderCustomController {
    
    /**
     * @description Real-time turn-by-turn messaging handler that receives client-side
     * inbound message events and triggers a Dynamic_PassThrough_Component notification
     * with text, URL, and image parameter bindings (capped under Salesforce 10-item limit).
     * 
     * @param sessionId The active MessagingSession ID or Conversation ID
     * @param messageText Raw text payload captured from the client event stream
     * @return Map containing execution status and debug details
     */
    @AuraEnabled
    public static Map<String, Object> handleIncomingTurn(String sessionId, String messageText) {
        Map<String, Object> response = new Map<String, Object>{
            'success' => false,
            'message' => '',
            'sessionId' => sessionId,
            'endUserId' => ''
        };

        System.debug('>>> [HeaderCustomController] Incoming turn request: sessionId=' + sessionId + ', messageText=' + messageText);
        
        try {
            List<MessagingSession> sessions = new List<MessagingSession>();

            Boolean isValidId = false;
            if (String.isNotBlank(sessionId) && (sessionId.length() == 15 || sessionId.length() == 18)) {
                try {
                    Id validCheck = (Id) sessionId;
                    isValidId = true;
                } catch (Exception idEx) {
                    isValidId = false;
                }
            }

            if (isValidId) {
                sessions = [
                    SELECT Id, MessagingEndUserId, ConversationId, Status 
                    FROM MessagingSession 
                    WHERE Id = :sessionId OR ConversationId = :sessionId 
                    ORDER BY CreatedDate DESC 
                    LIMIT 1
                ];
            } else if (String.isNotBlank(sessionId) && sessionId != 'ACTIVE_SESSION') {
                sessions = [
                    SELECT Id, MessagingEndUserId, ConversationId, Status 
                    FROM MessagingSession 
                    WHERE ConversationId = :sessionId 
                    ORDER BY CreatedDate DESC 
                    LIMIT 1
                ];
            }

            String activeSessionId;
            String endUserId;
            if (!sessions.isEmpty()) {
                activeSessionId = sessions[0].Id;
                endUserId = sessions[0].MessagingEndUserId;
            } else {
                List<MessagingSession> recentSessions = [
                    SELECT Id, MessagingEndUserId, ConversationId, Status 
                    FROM MessagingSession 
                    WHERE MessagingEndUserId != NULL 
                    ORDER BY CreatedDate DESC 
                    LIMIT 1
                ];
                if (!recentSessions.isEmpty()) {
                    activeSessionId = recentSessions[0].Id;
                    endUserId = recentSessions[0].MessagingEndUserId;
                }
            }

            if (String.isBlank(activeSessionId)) {
                response.put('message', 'Could not resolve active MessagingSession');
                return response;
            }

            response.put('endUserId', endUserId);

            // Strict Null/Blank Check on textValue
            String textValue = String.isNotBlank(messageText) ? messageText.trim() : '';
            if (String.isBlank(textValue) || textValue == 'null' || textValue == 'undefined') {
                textValue = 'Active Turn Message';
            }

            String formattedUrl = textValue;
            if (!formattedUrl.toLowerCase().contains('tubot.lat')) {
                formattedUrl = 'https://tubot.lat/?text=' + EncodingUtil.urlEncode(textValue, 'UTF-8');
            }

            String defaultImageUrl = 'https://www.salesforce.com/favicon.ico';

            // Retrieve System Access Token from Messaging_Config__c Custom Setting
            String token;
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            if (config != null && String.isNotBlank(config.Api_Token__c)) {
                token = config.Api_Token__c;
            } else {
                token = UserInfo.getSessionId();
            }

            if (String.isBlank(token)) {
                response.put('message', 'System API Token is missing in Messaging_Config__c');
                return response;
            }

            // Exactly 6 Parameter Items (Salesforce Limit = 10)
            List<Map<String, Object>> inputParametersList = new List<Map<String, Object>>{
                new Map<String, Object>{ 'name' => 'CustomText', 'textValue' => textValue },
                new Map<String, Object>{ 'name' => '$Parameters.CustomText', 'textValue' => textValue },
                new Map<String, Object>{ 'name' => '{!$Parameters.CustomText}', 'textValue' => textValue },
                new Map<String, Object>{ 'name' => 'CustomUrl', 'textValue' => formattedUrl },
                new Map<String, Object>{ 'name' => 'Url', 'textValue' => formattedUrl },
                new Map<String, Object>{ 'name' => 'CustomImage', 'textValue' => defaultImageUrl }
            };

            Map<String, Object> inputParams = new Map<String, Object>{
                'messageDefinitionName' => 'Dynamic_PassThrough_Component',
                'requestType' => 'SendNotificationMessages',
                'allowedSessionStatus' => 'Any',
                'isEnforceMessagingChannelConsent' => false,
                'messagingEndUserIds' => new List<String>{ endUserId },
                'messagingSessionId' => activeSessionId,
                'messagingDefinitionInputParameters' => inputParametersList,
                'messageParameters' => new Map<String, Object>{
                    'CustomText' => textValue,
                    'CustomUrl' => formattedUrl,
                    'CustomImage' => defaultImageUrl
                }
            };
            
            Map<String, Object> actionBody = new Map<String, Object>{
                'inputs' => new List<Map<String, Object>>{ inputParams }
            };
            
            HttpRequest req = new HttpRequest();
            req.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v61.0/actions/standard/sendConversationMessages');
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(actionBody));
            
            Http http = new Http();
            HttpResponse res = http.send(req);
            System.debug('>>> [HeaderCustomController] Action Callout Status: ' + res.getStatusCode() + ' | Body: ' + res.getBody());

            if (res.getStatusCode() == 200) {
                response.put('success', true);
                response.put('message', 'Component notification sent successfully via SSE Action Router');
            } else {
                response.put('message', 'Callout Error (' + res.getStatusCode() + '): ' + res.getBody());
            }

            // Step 2: Insert ConversationEntry DML SECOND (ensures database transcript log sync)
            try {
                Blob b = Crypto.generateAesKey(128);
                String h = EncodingUtil.convertToHex(b);
                String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                Integer nextSeq = 1;
                List<AggregateResult> maxSeqResult = [
                    SELECT MAX(Seq) maxSeq 
                    FROM ConversationEntry 
                    WHERE ConversationId = :activeSessionId
                ];
                if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                    nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                }

                Map<String, Object> parametersMap = new Map<String, Object>{
                    'CustomText' => textValue,
                    'CustomUrl' => formattedUrl,
                    'CustomImage' => defaultImageUrl,
                    '{!$Parameters.CustomText}' => textValue
                };

                Map<String, Object> componentPayload = new Map<String, Object>{
                    'messageType' => 'Component',
                    'componentName' => 'Dynamic_PassThrough_Component',
                    'parameters' => parametersMap,
                    'conversationId' => activeSessionId,
                    'messageIdentifier' => freshUuid
                };

                ConversationEntry entry = new ConversationEntry();
                entry.ConversationId = activeSessionId;
                entry.MessageIdentifier = freshUuid;
                entry.Message = JSON.serialize(componentPayload);
                entry.EntryType = 'Text';
                entry.Seq = nextSeq;
                entry.EntryTime = System.now();
                entry.ActorType = 'System';
                insert entry;

                System.debug('>>> [HeaderCustomController] Inserted ConversationEntry ID: ' + entry.Id + ' with Seq: ' + nextSeq);
                response.put('entryId', entry.Id);
            } catch (Exception dmlEx) {
                System.debug('>>> [HeaderCustomController] ConversationEntry DML note: ' + dmlEx.getMessage());
            }

        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return response;
    }
}
