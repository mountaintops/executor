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
                // 1. Target active/waiting sessions first by last modified date
                List<MessagingSession> activeSessions = [
                    SELECT Id, MessagingEndUserId, ConversationId, Status 
                    FROM MessagingSession 
                    WHERE MessagingEndUserId != NULL AND Status IN ('Active', 'Waiting', 'New', 'Progress') 
                    ORDER BY LastModifiedDate DESC 
                    LIMIT 1
                ];
                if (!activeSessions.isEmpty()) {
                    activeSessionId = activeSessions[0].Id;
                    endUserId = activeSessions[0].MessagingEndUserId;
                } else {
                    // 2. Fallback to most recently updated session
                    List<MessagingSession> recentSessions = [
                        SELECT Id, MessagingEndUserId, ConversationId, Status 
                        FROM MessagingSession 
                        WHERE MessagingEndUserId != NULL 
                        ORDER BY LastModifiedDate DESC 
                        LIMIT 1
                    ];
                    if (!recentSessions.isEmpty()) {
                        activeSessionId = recentSessions[0].Id;
                        endUserId = recentSessions[0].MessagingEndUserId;
                    }
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

            // Retrieve System Access Token & Config
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            String token = TopNotificationController.getApiSessionId();

            String keyword = (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent';
            String confirmationText = (config != null && String.isNotBlank(config.Confirmation_Text__c)) ? config.Confirmation_Text__c : 'transmited notification';
            String reactivationKeyword = (config != null && String.isNotBlank(config.Reactivation_Keyword__c)) ? config.Reactivation_Keyword__c : 'reset';

            String msgLower = textValue.toLowerCase();

            // 1. Check if user typed Reactivation Keyword (e.g. "reset")
            if (isUserInboundMessage && String.isNotBlank(messageText) && msgLower.contains(reactivationKeyword.toLowerCase())) {
                String resetNoticeText = '✅ Notification trigger reset. You can ask for an agent again. tubot.lat';
                try {
                    Blob b = Crypto.generateAesKey(128);
                    String h = EncodingUtil.convertToHex(b);
                    String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                    Integer nextSeq = 1;
                    List<AggregateResult> maxSeqResult = [SELECT MAX(Seq) maxSeq FROM ConversationEntry WHERE ConversationId = :activeSessionId];
                    if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                        nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                    }
                    ConversationEntry rEntry = new ConversationEntry();
                    rEntry.ConversationId = activeSessionId;
                    rEntry.MessageIdentifier = freshUuid;
                    rEntry.Message = resetNoticeText;
                    rEntry.EntryType = 'Text';
                    rEntry.Seq = nextSeq;
                    rEntry.EntryTime = System.now();
                    rEntry.ActorType = 'System';
                    insert rEntry;
                } catch (Exception rEx) {}

                response.put('success', true);
                response.put('message', 'Trigger reactivated successfully.');
                return response;
            }

            // 2. Check Session Mute Status (has user already spoken agent keyword without resetting?)
            Boolean isAlreadyTriggered = false;
            if (isUserInboundMessage) {
                try {
                    List<ConversationEntry> history = [
                        SELECT Message, EntryTime FROM ConversationEntry 
                        WHERE ConversationId = :activeSessionId 
                        ORDER BY Seq DESC LIMIT 25
                    ];
                    for (ConversationEntry ce : history) {
                        if (ce.Message != null) {
                            String cMsg = ce.Message.toLowerCase();
                            if (cMsg.contains(reactivationKeyword.toLowerCase())) {
                                isAlreadyTriggered = false; // Reset keyword found, unmuted!
                                break;
                            }
                            if (cMsg.contains(keyword.toLowerCase()) || cMsg.contains(confirmationText.toLowerCase()) || cMsg.contains('transmited notification')) {
                                isAlreadyTriggered = true; // Agent keyword spoken, muted!
                                break;
                            }
                        }
                    }
                } catch (Exception hEx) {}
            }

            Boolean isAgentKeyword = String.isNotBlank(messageText) && msgLower.contains(keyword.toLowerCase());

            // 3. IF NOT MUTED: ECHO (PING-PONG) COMPONENT NOTIFICATION BACK TO CUSTOMER FIRST (REST Callout before DML)
            if (!isAlreadyTriggered && !isAgentKeyword) {
                dispatchComponentNotification(token, activeSessionId, endUserId, textValue, formattedUrl, defaultImageUrl);
            }

            // 4. Always dispatch Top Notification Bar broadcast AFTER callouts
            if (isUserInboundMessage) {
                dispatchAgentTopBarNotification(config, activeSessionId, endUserId, messageText, isAgentKeyword);
            }

            // 5. If user typed Agent Keyword (e.g. "agent")
            if (isUserInboundMessage && isAgentKeyword) {
                if (isAlreadyTriggered) {
                    System.debug('>>> [HeaderCustomController] Trigger is already active for session ' + activeSessionId + '. Muted until reactivation keyword (' + reactivationKeyword + ') is sent.');
                    response.put('message', 'Trigger already active. Muted until reactivation keyword is spoken.');
                    return response;
                }

                // Insert confirmation text back to customer ("transmited notification tubot.lat")
                try {
                    Blob b = Crypto.generateAesKey(128);
                    String h = EncodingUtil.convertToHex(b);
                    String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                    Integer nextSeq = 1;
                    List<AggregateResult> maxSeqResult = [SELECT MAX(Seq) maxSeq FROM ConversationEntry WHERE ConversationId = :activeSessionId];
                    if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                        nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                    }
                    ConversationEntry cEntry = new ConversationEntry();
                    cEntry.ConversationId = activeSessionId;
                    cEntry.MessageIdentifier = freshUuid;
                    cEntry.Message = confirmationText + ' tubot.lat';
                    cEntry.EntryType = 'Text';
                    cEntry.Seq = nextSeq;
                    cEntry.EntryTime = System.now();
                    cEntry.ActorType = 'System';
                    insert cEntry;
                } catch (Exception cEx) {}

                response.put('success', true);
                response.put('message', 'Agent requested and notification dispatched.');
                return response;
            }

            // 6. IF MUTED:
            if (isAlreadyTriggered) {
                System.debug('>>> [HeaderCustomController] Echo muted for session ' + activeSessionId + ' because agent keyword was activated.');
                response.put('message', 'Echo muted because agent keyword was activated.');
                return response;
            }

            response.put('success', true);
            response.put('message', 'Component notification echoed successfully!');
        } catch (Exception ex) {
            System.debug('>>> [HeaderCustomController] Exception: ' + ex.getMessage() + '\n' + ex.getStackTraceString());
            response.put('message', 'Exception: ' + ex.getMessage());
        }

        return response;
    }

    /**
     * @description Dispatches standard component notification REST callout & ConversationEntry record.
     */
    private static void dispatchComponentNotification(
        String token,
        String activeSessionId,
        String endUserId,
        String textValue,
        String formattedUrl,
        String defaultImageUrl
    ) {
        // 1. Dispatch REST Callout
        if (String.isNotBlank(token)) {
            try {
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
                HttpResponse resCallout = http.send(req);
                System.debug('>>> [HeaderCustomController] Action Callout Status: ' + resCallout.getStatusCode() + ' | Body: ' + resCallout.getBody());
            } catch (Exception calloutEx) {
                System.debug('>>> [HeaderCustomController] Callout note: ' + calloutEx.getMessage());
            }
        }

        // 2. Insert ConversationEntry with Dynamic_PassThrough_Component JSON payload
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
                '$Parameters.CustomText' => textValue,
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

            System.debug('>>> [HeaderCustomController] Inserted Dynamic_PassThrough_Component ConversationEntry ID: ' + entry.Id + ' with Seq: ' + nextSeq);
        } catch (Exception dmlEx) {
            System.debug('>>> [HeaderCustomController] ConversationEntry DML note: ' + dmlEx.getMessage());
        }
    }

    /**
     * @description Helper to dispatch Top Notification Bar broadcast on customer messages.
     */
    private static void dispatchAgentTopBarNotification(Messaging_Config__c config, String activeSessionId, String endUserId, String customMessageText, Boolean isAgentRequest) {
        try {
            Boolean detectJoinedAgent = (config != null && config.Detect_Joined_Agent__c != null) ? config.Detect_Joined_Agent__c : true;
            Boolean isGlobalDefault = (config != null && config.Is_Global_Default__c != null) ? config.Is_Global_Default__c : false;
            Boolean autoQueueDetector = (config != null && config.Auto_Queue_Detector__c != null) ? config.Auto_Queue_Detector__c : true;
            Boolean useFlowRouting = (config != null && config.Use_Flow_Routing__c != null) ? config.Use_Flow_Routing__c : true;
            String selectedChannelFilter = (config != null && String.isNotBlank(config.Selected_Messaging_Channel_Id__c)) ? config.Selected_Messaging_Channel_Id__c : 'ALL';

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

            String disabledChannelsStr = (config != null && String.isNotBlank(config.Disabled_Channel_Ids__c)) ? config.Disabled_Channel_Ids__c : '';
            Set<String> disabledChannelSet = new Set<String>();
            if (String.isNotBlank(disabledChannelsStr)) {
                for (String dId : disabledChannelsStr.split(',')) {
                    if (String.isNotBlank(dId.trim())) {
                        disabledChannelSet.add(dId.trim());
                    }
                }
            }

            String joinedAgentId = null;
            Boolean hasAgentJoined = false;
            String routedQueueId = null;

            if (String.isNotBlank(activeSessionId)) {
                List<MessagingSession> msList = [
                    SELECT Id, OwnerId, MessagingChannelId FROM MessagingSession WHERE Id = :activeSessionId LIMIT 1
                ];
                if (!msList.isEmpty()) {
                    MessagingSession sessionRec = msList[0];

                    String ownerIdStr = String.valueOf(sessionRec.OwnerId);
                    if (detectJoinedAgent && String.isNotBlank(ownerIdStr) && ownerIdStr.startsWith('005')) {
                        joinedAgentId = ownerIdStr;
                        hasAgentJoined = true;
                    } else if (String.isNotBlank(ownerIdStr) && ownerIdStr.startsWith('00G')) {
                        routedQueueId = ownerIdStr;
                    }
                }

                if (useFlowRouting && !hasAgentJoined && String.isBlank(routedQueueId)) {
                    try {
                        List<PendingServiceRouting> psrList = [
                            SELECT Id, GroupId, WorkItemId FROM PendingServiceRouting WHERE WorkItemId = :activeSessionId LIMIT 1
                        ];
                        if (!psrList.isEmpty() && String.isNotBlank(psrList[0].GroupId)) {
                            routedQueueId = String.valueOf(psrList[0].GroupId);
                        }
                    } catch (Exception psrEx) {}
                }
            }

            String cleanBodyMsg = String.isNotBlank(customMessageText) ? customMessageText.replace('tubot.lat', '').trim() : 'Sent a message';

            Map<String, Object> payload = new Map<String, Object>();
            payload.put('deactivateOthers', true);
            payload.put('isDismissible', true);
            payload.put('theme', 'warning');

            if (hasAgentJoined) {
                payload.put('title', isAgentRequest ? '📢 Customer Requested Assistance' : '💬 New Message from ' + customerName);
                payload.put('message', isAgentRequest ? (customerName + ' requested assistance in your assigned session.') : (customerName + ': ' + cleanBodyMsg));
                payload.put('isGlobal', false);
                payload.put('targetUserIds', joinedAgentId);
            } else {
                payload.put('title', isAgentRequest ? '📢 Customer Requested Agent' : '💬 New Message from ' + customerName);
                payload.put('message', isAgentRequest ? (customerName + ' has asked for an agent.') : (customerName + ': ' + cleanBodyMsg));

                String singleFlowUser = null;
                if (useFlowRouting) {
                    singleFlowUser = resolveSingleFlowTargetUser(activeSessionId, routedQueueId);
                }

                if (isGlobalDefault) {
                    payload.put('isGlobal', true);
                } else if (useFlowRouting && String.isNotBlank(singleFlowUser)) {
                    payload.put('isGlobal', false);
                    payload.put('targetUserIds', singleFlowUser);
                } else if (String.isNotBlank(routedQueueId)) {
                    payload.put('isGlobal', false);
                    payload.put('targetGroupIds', routedQueueId);
                } else if (autoQueueDetector) {
                    payload.put('isGlobal', false);
                    Set<String> queueUserIds = getChatQueueUserIds();
                    String targetSingleUser = !queueUserIds.isEmpty() ? new List<String>(queueUserIds)[0] : null;
                    if (String.isNotBlank(targetSingleUser)) {
                        payload.put('targetUserIds', targetSingleUser);
                    } else {
                        payload.put('targetUserIds', String.join(new List<String>(queueUserIds), ','));
                    }
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
        } catch (Exception notifEx) {
            System.debug('>>> [HeaderCustomController] Top notification bar dispatch error: ' + notifEx.getMessage());
        }
    }

    /**
     * @description Resolves the exact SINGLE user designated by Salesforce Omni-Channel Routing
     * (AgentWork, PreferredUserId, or Omni-Channel Presence in Queue) to ensure only ONE user gets pinged.
     */
    private static String resolveSingleFlowTargetUser(String activeSessionId, String routedQueueId) {
        if (String.isBlank(activeSessionId)) {
            return null;
        }

        // 1. Check AgentWork (Salesforce Omni-Channel Work Assignment to a single user)
        try {
            List<AgentWork> awList = [
                SELECT Id, UserId, Status 
                FROM AgentWork 
                WHERE WorkItemId = :activeSessionId AND Status IN ('Assigned', 'Opened', 'Transferred') 
                ORDER BY CreatedDate DESC 
                LIMIT 1
            ];
            if (!awList.isEmpty() && String.isNotBlank(String.valueOf(awList[0].UserId))) {
                String awUserId = String.valueOf(awList[0].UserId);
                if (awUserId.startsWith('005')) {
                    System.debug('>>> [HeaderCustomController] Omni-Channel AgentWork resolved single user: ' + awUserId);
                    return awUserId;
                }
            }
        } catch (Exception awEx) {
            System.debug('>>> [HeaderCustomController] AgentWork query note: ' + awEx.getMessage());
        }

        // 2. Check PendingServiceRouting PreferredUserId
        try {
            List<PendingServiceRouting> psrList = [
                SELECT Id, GroupId, PreferredUserId FROM PendingServiceRouting WHERE WorkItemId = :activeSessionId LIMIT 1
            ];
            if (!psrList.isEmpty()) {
                if (String.isNotBlank(String.valueOf(psrList[0].PreferredUserId)) && String.valueOf(psrList[0].PreferredUserId).startsWith('005')) {
                    String prefUserId = String.valueOf(psrList[0].PreferredUserId);
                    System.debug('>>> [HeaderCustomController] Omni PSR PreferredUserId resolved single user: ' + prefUserId);
                    return prefUserId;
                }
                if (String.isBlank(routedQueueId) && String.isNotBlank(String.valueOf(psrList[0].GroupId))) {
                    routedQueueId = String.valueOf(psrList[0].GroupId);
                }
            }
        } catch (Exception psrEx) {
            System.debug('>>> [HeaderCustomController] PSR query note: ' + psrEx.getMessage());
        }

        // 3. Resolve single best available user from the routed queue
        if (String.isNotBlank(routedQueueId)) {
            try {
                List<GroupMember> gmList = [
                    SELECT UserOrGroupId 
                    FROM GroupMember 
                    WHERE GroupId = :routedQueueId 
                    LIMIT 50
                ];
                Set<Id> queueUserIds = new Set<Id>();
                for (GroupMember gm : gmList) {
                    if (String.valueOf(gm.UserOrGroupId).startsWith('005')) {
                        queueUserIds.add(gm.UserOrGroupId);
                    }
                }

                if (!queueUserIds.isEmpty()) {
                    // Check online agents in Omni-Channel
                    try {
                        List<UserServicePresence> uspList = [
                            SELECT UserId 
                            FROM UserServicePresence 
                            WHERE IsAway = false AND UserId IN :queueUserIds 
                            ORDER BY CreatedDate DESC 
                            LIMIT 1
                        ];
                        if (!uspList.isEmpty()) {
                            String onlineUserId = String.valueOf(uspList[0].UserId);
                            System.debug('>>> [HeaderCustomController] Omni-Channel Online Queue Member resolved single user: ' + onlineUserId);
                            return onlineUserId;
                        }
                    } catch (Exception uspEx) {
                        System.debug('>>> [HeaderCustomController] UserServicePresence note: ' + uspEx.getMessage());
                    }

                    // Fallback to first active queue member user
                    String defaultSingleUser = String.valueOf(new List<Id>(queueUserIds)[0]);
                    System.debug('>>> [HeaderCustomController] Single Queue Member fallback resolved user: ' + defaultSingleUser);
                    return defaultSingleUser;
                }
            } catch (Exception gmEx) {
                System.debug('>>> [HeaderCustomController] GroupMember note: ' + gmEx.getMessage());
            }
        }

        return null;
    }
}

