public without sharing class HeaderCustomController {
    
    /**
     * @description Real-time turn-by-turn messaging handler that receives client-side
     * inbound message events and triggers a Dynamic_PassThrough_Component rich text notification
     * via the sendConversationMessages action router using system auth credentials.
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

            String endUserId;
            if (!sessions.isEmpty() && sessions[0].MessagingEndUserId != null) {
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
                    endUserId = recentSessions[0].MessagingEndUserId;
                }
            }

            if (String.isBlank(endUserId)) {
                response.put('message', 'Could not resolve active MessagingEndUserId');
                return response;
            }

            response.put('endUserId', endUserId);

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

            // Construct sendConversationMessages payload
            Map<String, Object> inputParams = new Map<String, Object>{
                'messageDefinitionName' => 'Dynamic_PassThrough_Component',
                'requestType' => 'SendNotificationMessages',
                'allowedSessionStatus' => 'Any',
                'isEnforceMessagingChannelConsent' => false,
                'messagingEndUserIds' => new List<String>{ endUserId }
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
                response.put('message', 'Component notification sent successfully');
            } else {
                response.put('message', 'Callout Error (' + res.getStatusCode() + '): ' + res.getBody());
            }

        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return response;
    }
}
