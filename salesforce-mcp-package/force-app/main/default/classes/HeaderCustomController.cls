public without sharing class HeaderCustomController {
    
    // Caching static variables to search for CustomNotificationType and Queue members ONLY ONCE per execution
    private static Id cachedNotificationTypeId;
    private static Set<String> cachedQueueUserIds;

    /**
     * @description Helper method that queries and caches the CustomNotificationType ID for 'Agent'.
     */
    private static Id getAgentNotificationTypeId() {
        if (cachedNotificationTypeId == null) {
            List<CustomNotificationType> notifTypes = [
                SELECT Id 
                FROM CustomNotificationType 
                WHERE DeveloperName = 'Agent' OR MasterLabel = 'Agent'
                LIMIT 1
            ];
            if (!notifTypes.isEmpty()) {
                cachedNotificationTypeId = notifTypes[0].Id;
            }
        }
        return cachedNotificationTypeId;
    }

    /**
     * @description Helper method that queries and caches the User IDs of all members
     * belonging to the 'Chat Queue'.
     */
    private static Set<String> getChatQueueUserIds() {
        if (cachedQueueUserIds == null) {
            cachedQueueUserIds = new Set<String>();
            List<Group> queues = [
                SELECT Id 
                FROM Group 
                WHERE Type = 'Queue' AND (Name = 'Chat Queue' OR DeveloperName = 'Chat_Queue')
                LIMIT 1
            ];
            if (!queues.isEmpty()) {
                for (GroupMember member : [
                    SELECT UserOrGroupId 
                    FROM GroupMember 
                    WHERE GroupId = :queues[0].Id
                ]) {
                    if (String.valueOf(member.UserOrGroupId).startsWith('005')) {
                        cachedQueueUserIds.add((String) member.UserOrGroupId);
                    }
                }
            }
            // Fallback to current running user if queue has no direct user members in dev context
            if (cachedQueueUserIds.isEmpty()) {
                cachedQueueUserIds.add(UserInfo.getUserId());
            }
        }
        return cachedQueueUserIds;
    }

    /**
     * @description Real-time turn-by-turn messaging handler that receives client-side
     * message events, triggers a Dynamic_PassThrough_Component notification,
     * and dispatches a CustomNotification to 'Chat Queue' members ONLY FOR INBOUND USER MESSAGES asking for an 'Agent'.
     * 
     * @param sessionId The active MessagingSession ID or Conversation ID
     * @param messageText Raw text payload captured from the client event stream
     * @param isInbound Boolean flag indicating whether the message is inbound from customer (true) or outbound (false)
     * @return Map containing execution status and debug details
     */
    @AuraEnabled
    public static Map<String, Object> handleIncomingTurn(String sessionId, String messageText, Boolean isInbound) {
        Map<String, Object> response = new Map<String, Object>{
            'success' => false,
            'message' => '',
            'sessionId' => sessionId,
            'endUserId' => ''
        };

        Boolean isUserInboundMessage = (isInbound == null) ? true : isInbound;

        System.debug('>>> [HeaderCustomController] Incoming turn request: sessionId=' + sessionId + ', messageText=' + messageText + ', isUserInboundMessage=' + isUserInboundMessage);
        
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

            // Append "tubot.lat" marker text if not present
            if (!textValue.toLowerCase().contains('tubot.lat')) {
                textValue = textValue + ' tubot.lat';
            }

            String formattedUrl = textValue;
            if (!formattedUrl.toLowerCase().startsWith('http')) {
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

            // Step 1: Dispatch sendConversationMessages Callout FIRST (before any DML/Notification send)
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

            // Step 2: Insert ConversationEntry DML SECOND
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

            // Step 3: Dispatch Top Notification Bar Broadcast (ONLY FOR INBOUND USER MESSAGES asking for "agent" or custom keyword)
            if (isUserInboundMessage && String.isNotBlank(messageText)) {
                try {
                    String keyword = (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent';

                    if (messageText.toLowerCase().contains(keyword.toLowerCase())) {
                        Boolean detectJoinedAgent = (config != null && config.Detect_Joined_Agent__c != null) ? config.Detect_Joined_Agent__c : true;
                        Boolean isGlobalDefault = (config != null && config.Is_Global_Default__c != null) ? config.Is_Global_Default__c : false;
                        Boolean autoQueueDetector = (config != null && config.Auto_Queue_Detector__c != null) ? config.Auto_Queue_Detector__c : true;

                        String customerName = 'Customer';
                        if (String.isNotBlank(endUserId)) {
                            List<MessagingEndUser> endUsers = [
                                SELECT Name 
                                FROM MessagingEndUser 
                                WHERE Id = :endUserId 
                                LIMIT 1
                            ];
                            if (!endUsers.isEmpty() && String.isNotBlank(endUsers[0].Name)) {
                                customerName = endUsers[0].Name;
                            }
                        }

                        // Inspect MessagingSession owner to check if an agent has joined
                        String joinedAgentId = null;
                        Boolean hasAgentJoined = false;

                        if (detectJoinedAgent && String.isNotBlank(activeSessionId)) {
                            List<MessagingSession> msList = [
                                SELECT Id, OwnerId FROM MessagingSession WHERE Id = :activeSessionId LIMIT 1
                            ];
                            if (!msList.isEmpty()) {
                                String ownerIdStr = String.valueOf(msList[0].OwnerId);
                                if (String.isNotBlank(ownerIdStr) && ownerIdStr.startsWith('005')) {
                                    joinedAgentId = ownerIdStr;
                                    hasAgentJoined = true;
                                }
                            }
                        }

                        Map<String, Object> payload = new Map<String, Object>();
                        payload.put('deactivateOthers', true);
                        payload.put('isDismissible', true);
                        payload.put('theme', 'warning');

                        if (hasAgentJoined) {
                            // IF AGENT HAS JOINED: ONLY BROADCAST TOP BAR TO THAT JOINED AGENT
                            payload.put('title', '📢 Customer Requested Assistance');
                            payload.put('message', customerName + ' requested assistance in your assigned messaging session.');
                            payload.put('isGlobal', false);
                            payload.put('targetUserIds', joinedAgentId);
                            System.debug('>>> [HeaderCustomController] Joined Agent detected (' + joinedAgentId + '). Broadcasting top bar to joined agent only.');
                        } else {
                            // IF NO AGENT HAS JOINED: BROADCAST TO ALL IN QUEUE (or target group)
                            payload.put('title', '📢 Customer Requested Agent in Queue');
                            payload.put('message', customerName + ' has asked for an agent in Chat Queue.');

                            if (isGlobalDefault) {
                                payload.put('isGlobal', true);
                            } else if (autoQueueDetector) {
                                payload.put('isGlobal', false);
                                Set<String> queueUserIds = getChatQueueUserIds();
                                payload.put('targetUserIds', String.join(new List<String>(queueUserIds), ','));
                            } else if (config != null && String.isNotBlank(config.Target_Group_Id__c)) {
                                payload.put('isGlobal', false);
                                payload.put('targetGroupIds', config.Target_Group_Id__c);
                            } else {
                                payload.put('isGlobal', false);
                                Set<String> queueUserIds = getChatQueueUserIds();
                                payload.put('targetUserIds', String.join(new List<String>(queueUserIds), ','));
                            }
                        }

                        TopNotificationController.saveAndActivateNotification(payload);
                        System.debug('>>> [HeaderCustomController] Top Notification Bar broadcast activated for keyword "' + keyword + '".');
                    }
                } catch (Exception notifEx) {
                    System.debug('>>> [HeaderCustomController] Top notification bar dispatch error: ' + notifEx.getMessage());
                }
            } else if (!isUserInboundMessage) {
                System.debug('>>> [HeaderCustomController] Skipped Top Notification Bar because message is OUTBOUND.');
            }

        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return response;
    }
}
