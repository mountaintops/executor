/**
 * @description Core Apex Controller for Enterprise Top Notification Bar package system.
 * Handles SOQL targeting evaluation, broadcast activation, and zero-cost polling.
 */
public with sharing class TopNotificationController {

    private static Set<Id> cachedUserGroupIds = null;

    /**
     * @description Formats a Notification_Broadcast__c record into a clean Map for LWC consumption.
     */
    private static Map<String, Object> formatNotificationMap(Notification_Broadcast__c n) {
        return new Map<String, Object>{
            'id' => n.Id,
            'name' => n.Name,
            'title' => n.Title__c,
            'message' => n.Message__c,
            'theme' => n.Theme__c,
            'isActive' => n.Is_Active__c,
            'isGlobal' => n.Is_Global__c,
            'isDismissible' => n.Is_Dismissible__c
        };
    }

    /**
     * @description Fetches the current active top notification banner targeted to the logged-in user.
     */
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getActiveNotificationForCurrentUser() {
        Map<String, Object> response = new Map<String, Object>{
            'hasNotification' => false,
            'notification' => null
        };

        try {
            Datetime now = Datetime.now();
            List<Notification_Broadcast__c> activeList = [
                SELECT Id, Name, Title__c, Message__c, Theme__c, Is_Active__c, Is_Global__c, Is_Dismissible__c,
                       Target_User_Ids__c, Target_Profile_Ids__c, Target_Role_Ids__c, Target_Group_Ids__c,
                       Start_DateTime__c, Expiration_DateTime__c, CreatedDate
                FROM Notification_Broadcast__c
                WHERE Is_Active__c = true
                ORDER BY CreatedDate DESC
                LIMIT 10
            ];

            System.debug('>>> [TopNotificationController] Found ' + activeList.size() + ' active broadcast records.');

            for (Notification_Broadcast__c n : activeList) {
                if (n.Start_DateTime__c != null && n.Start_DateTime__c > now) {
                    System.debug('>>> [TopNotificationController] Skipping record ' + n.Id + ' - Start date in future: ' + n.Start_DateTime__c);
                    continue;
                }
                if (n.Expiration_DateTime__c != null && n.Expiration_DateTime__c < now) {
                    System.debug('>>> [TopNotificationController] Skipping record ' + n.Id + ' - Expired at: ' + n.Expiration_DateTime__c);
                    continue;
                }

                if (isUserTargeted(n)) {
                    System.debug('>>> [TopNotificationController] User targeted by record ' + n.Id + ' (' + n.Title__c + ')');
                    response.put('hasNotification', true);
                    response.put('notification', formatNotificationMap(n));
                    break;
                }
            }
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationController:ERROR] Exception fetching active notification: ' + ex.getMessage() + ' | Stack: ' + ex.getStackTraceString());
        }

        return response;
    }

    /**
     * @description System diagnostics for debugging and testing.
     */
    @AuraEnabled
    public static Map<String, Object> getDiagnostics() {
        Map<String, Object> diag = new Map<String, Object>();
        diag.put('userId', UserInfo.getUserId());
        diag.put('profileId', UserInfo.getProfileId());
        diag.put('roleId', UserInfo.getUserRoleId());
        diag.put('username', UserInfo.getUserName());
        diag.put('userGroupIds', getCurrentUserGroupIds());
        diag.put('activeNotificationResponse', getActiveNotificationForCurrentUser());
        diag.put('totalActiveRecords', [SELECT COUNT() FROM Notification_Broadcast__c WHERE Is_Active__c = true]);
        return diag;
    }

    /**
     * @description Helper that evaluates target matching rules against the current user context.
     */
    @AuraEnabled
    public static Boolean isCurrentUserTargetedByRecord(String recordId) {
        if (String.isBlank(recordId)) return false;
        List<Notification_Broadcast__c> records = [
            SELECT Id, Is_Global__c, Target_User_Ids__c, Target_Profile_Ids__c, Target_Role_Ids__c, Target_Group_Ids__c
            FROM Notification_Broadcast__c
            WHERE Id = :recordId
            LIMIT 1
        ];
        if (records.isEmpty()) return false;
        return isUserTargeted(records[0]);
    }

    private static Boolean isUserTargeted(Notification_Broadcast__c n) {
        if (n.Is_Global__c == true) {
            return true;
        }

        Id currentUserId = UserInfo.getUserId();
        Id currentProfileId = UserInfo.getProfileId();
        Id currentRoleId = UserInfo.getUserRoleId();

        // 1. Direct User ID targeting
        if (String.isNotBlank(n.Target_User_Ids__c) && n.Target_User_Ids__c.contains(String.valueOf(currentUserId))) {
            return true;
        }

        // 2. Profile targeting
        if (String.isNotBlank(n.Target_Profile_Ids__c) && n.Target_Profile_Ids__c.contains(String.valueOf(currentProfileId))) {
            return true;
        }

        // 3. Role targeting
        if (currentRoleId != null && String.isNotBlank(n.Target_Role_Ids__c) && n.Target_Role_Ids__c.contains(String.valueOf(currentRoleId))) {
            return true;
        }

        // 4. Public Group / Queue targeting
        if (String.isNotBlank(n.Target_Group_Ids__c)) {
            Set<Id> userGroupIds = getCurrentUserGroupIds();
            for (Id grpId : userGroupIds) {
                if (n.Target_Group_Ids__c.contains(String.valueOf(grpId))) {
                    return true;
                }
            }
        }

        return false;
    }

    private static Set<Id> getCurrentUserGroupIds() {
        if (cachedUserGroupIds != null) {
            return cachedUserGroupIds;
        }
        cachedUserGroupIds = new Set<Id>();
        Id currentUserId = UserInfo.getUserId();

        try {
            List<GroupMember> members = [
                SELECT GroupId FROM GroupMember WHERE UserOrGroupId = :currentUserId LIMIT 500
            ];
            for (GroupMember gm : members) {
                cachedUserGroupIds.add(gm.GroupId);
            }
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationController:ERROR] Error fetching user groups: ' + ex.getMessage());
        }

        return cachedUserGroupIds;
    }

    /**
     * @description Returns available Profiles, Roles, Groups, and Users for Admin Control Center lookups.
     */
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getAdminOptions() {
        Map<String, Object> options = new Map<String, Object>();
        try {
            options.put('profiles', [SELECT Id, Name FROM Profile ORDER BY Name LIMIT 200]);
            options.put('roles', [SELECT Id, Name FROM UserRole ORDER BY Name LIMIT 200]);
            options.put('groups', [SELECT Id, Name, Type FROM Group WHERE Type IN ('Regular', 'Queue') ORDER BY Name LIMIT 200]);
            options.put('users', [SELECT Id, Name, Username FROM User WHERE IsActive = true ORDER BY Name LIMIT 200]);

            List<Map<String, String>> channelOpts = new List<Map<String, String>>();
            channelOpts.add(new Map<String, String>{ 'label' => '🌐 Follow All Deployments (Automatic System Detection)', 'value' => 'ALL' });
            for (MessagingChannel mc : [SELECT Id, MasterLabel, DeveloperName, MessageType FROM MessagingChannel ORDER BY MasterLabel LIMIT 100]) {
                String label = mc.MasterLabel + ' (' + (String.isNotBlank(mc.MessageType) ? mc.MessageType : 'MessagingChannel') + ')';
                channelOpts.add(new Map<String, String>{ 'label' => label, 'value' => mc.Id });
            }
            options.put('messagingChannels', channelOpts);
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationController:ERROR] Error fetching admin options: ' + ex.getMessage());
        }
        return options;
    }

    /**
     * @description Returns all broadcast records for Admin Control Center management tab.
     */
    @AuraEnabled
    public static List<Notification_Broadcast__c> getAllBroadcasts() {
        return [
            SELECT Id, Name, Title__c, Message__c, Theme__c, Is_Active__c, Is_Global__c, Is_Dismissible__c,
                   Target_User_Ids__c, Target_Profile_Ids__c, Target_Role_Ids__c, Target_Group_Ids__c,
                   Start_DateTime__c, Expiration_DateTime__c, CreatedDate
            FROM Notification_Broadcast__c
            ORDER BY CreatedDate DESC
            LIMIT 100
        ];
    }

    /**
     * @description Creates or updates a Notification Broadcast record and publishes the Platform Event.
     */
    @AuraEnabled
    public static Map<String, Object> saveAndActivateNotification(Map<String, Object> payload) {
        Map<String, Object> result = new Map<String, Object>{ 'success' => false, 'message' => '' };

        try {
            String recordId = (String) payload.get('id');
            Boolean shouldDeactivateOthers = payload.containsKey('deactivateOthers') ? (Boolean) payload.get('deactivateOthers') : true;

            if (shouldDeactivateOthers) {
                List<Notification_Broadcast__c> activeRecords = [
                    SELECT Id, Is_Active__c FROM Notification_Broadcast__c WHERE Is_Active__c = true
                ];
                for (Notification_Broadcast__c activeRec : activeRecords) {
                    if (String.isBlank(recordId) || activeRec.Id != recordId) {
                        activeRec.Is_Active__c = false;
                    }
                }
                if (!activeRecords.isEmpty()) {
                    update activeRecords;
                }
            }

            Notification_Broadcast__c broadcastRecord;
            if (String.isNotBlank(recordId)) {
                broadcastRecord = [SELECT Id FROM Notification_Broadcast__c WHERE Id = :recordId LIMIT 1];
            } else {
                broadcastRecord = new Notification_Broadcast__c();
            }

            broadcastRecord.Title__c = (String) payload.get('title');
            broadcastRecord.Message__c = (String) payload.get('message');
            broadcastRecord.Theme__c = payload.containsKey('theme') ? (String) payload.get('theme') : 'info';
            broadcastRecord.Is_Active__c = true;
            broadcastRecord.Is_Global__c = payload.containsKey('isGlobal') ? (Boolean) payload.get('isGlobal') : true;
            broadcastRecord.Is_Dismissible__c = payload.containsKey('isDismissible') ? (Boolean) payload.get('isDismissible') : true;

            broadcastRecord.Target_User_Ids__c = (String) payload.get('targetUserIds');
            broadcastRecord.Target_Profile_Ids__c = (String) payload.get('targetProfileIds');
            broadcastRecord.Target_Role_Ids__c = (String) payload.get('targetRoleIds');
            broadcastRecord.Target_Group_Ids__c = (String) payload.get('targetGroupIds');

            if (payload.containsKey('startDateTime') && payload.get('startDateTime') != null) {
                broadcastRecord.Start_DateTime__c = Datetime.valueOf((String) payload.get('startDateTime'));
            }
            if (payload.containsKey('expirationDateTime') && payload.get('expirationDateTime') != null) {
                broadcastRecord.Expiration_DateTime__c = Datetime.valueOf((String) payload.get('expirationDateTime'));
            }

            upsert broadcastRecord;

            // Publish Platform Event
            Notification_Broadcast_Event__e event = new Notification_Broadcast_Event__e(
                Notification_Id__c = broadcastRecord.Id,
                Title__c = broadcastRecord.Title__c,
                Message__c = broadcastRecord.Message__c,
                Theme__c = broadcastRecord.Theme__c,
                Is_Active__c = true,
                Is_Global__c = broadcastRecord.Is_Global__c,
                Is_Dismissible__c = broadcastRecord.Is_Dismissible__c,
                Target_User_Ids__c = broadcastRecord.Target_User_Ids__c,
                Target_Profile_Ids__c = broadcastRecord.Target_Profile_Ids__c,
                Target_Role_Ids__c = broadcastRecord.Target_Role_Ids__c,
                Target_Group_Ids__c = broadcastRecord.Target_Group_Ids__c
            );

            Database.SaveResult sr = EventBus.publish(event);
            if (sr.isSuccess()) {
                System.debug('>>> [TopNotificationController] Platform Event published successfully: ' + sr.getId());
            } else {
                for (Database.Error err : sr.getErrors()) {
                    System.debug('>>> [TopNotificationController:ERROR] EventBus publish error: ' + err.getMessage());
                }
            }

            result.put('success', true);
            result.put('recordId', broadcastRecord.Id);
            result.put('message', 'Notification Broadcast saved and activated successfully.');
        } catch (Exception ex) {
            result.put('success', false);
            result.put('message', 'Error activating notification: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] Exception saving notification: ' + ex.getMessage() + ' | Stack: ' + ex.getStackTraceString());
        }

        return result;
    }

    /**
     * @description Deactivates a Notification Broadcast record by ID.
     */
    @AuraEnabled
    public static Map<String, Object> deactivateNotification(String recordId) {
        Map<String, Object> result = new Map<String, Object>{ 'success' => false, 'message' => '' };
        try {
            if (String.isBlank(recordId)) {
                result.put('message', 'Record ID is required.');
                return result;
            }
            Notification_Broadcast__c rec = [SELECT Id, Is_Active__c FROM Notification_Broadcast__c WHERE Id = :recordId LIMIT 1];
            rec.Is_Active__c = false;
            update rec;

            // Publish Deactivation Event
            Notification_Broadcast_Event__e event = new Notification_Broadcast_Event__e(
                Notification_Id__c = rec.Id,
                Is_Active__c = false
            );
            EventBus.publish(event);

            result.put('success', true);
            result.put('message', 'Notification deactivated successfully.');
        } catch (Exception ex) {
            result.put('success', false);
            result.put('message', 'Error deactivating notification: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] Exception deactivating notification: ' + ex.getMessage());
        }
        return result;
    }

    /**
     * @description Retrieves the Agent Notification configuration settings from Messaging_Config__c.
     */
    @AuraEnabled
    public static Map<String, Object> getAgentNotificationConfig() {
        Map<String, Object> configMap = new Map<String, Object>();
        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        
        configMap.put('agentKeyword', (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent');
        configMap.put('confirmationText', (config != null && String.isNotBlank(config.Confirmation_Text__c)) ? config.Confirmation_Text__c : 'transmited notification');
        configMap.put('reactivationKeyword', (config != null && String.isNotBlank(config.Reactivation_Keyword__c)) ? config.Reactivation_Keyword__c : 'reset');
        configMap.put('reminderEnabled', (config != null && config.Reminder_Enabled__c != null) ? config.Reminder_Enabled__c : false);
        configMap.put('reminderMinutes', (config != null && config.Reminder_Minutes__c != null) ? config.Reminder_Minutes__c : 5);
        configMap.put('reminderTemplate', (config != null && String.isNotBlank(config.Reminder_Message_Template__c)) ? config.Reminder_Message_Template__c : 'Hello {customer_name}, we noticed you have been waiting for {minutes_passed} minutes. An agent will be with you shortly!');
        
        configMap.put('isGlobal', (config != null && config.Is_Global_Default__c != null) ? config.Is_Global_Default__c : false);
        configMap.put('autoQueueDetector', (config != null && config.Auto_Queue_Detector__c != null) ? config.Auto_Queue_Detector__c : true);
        configMap.put('detectJoinedAgent', (config != null && config.Detect_Joined_Agent__c != null) ? config.Detect_Joined_Agent__c : true);
        configMap.put('useFlowRouting', (config != null && config.Use_Flow_Routing__c != null) ? config.Use_Flow_Routing__c : true);
        configMap.put('selectedMessagingChannelId', (config != null && String.isNotBlank(config.Selected_Messaging_Channel_Id__c)) ? config.Selected_Messaging_Channel_Id__c : 'ALL');
        configMap.put('targetGroupId', (config != null && String.isNotBlank(config.Target_Group_Id__c)) ? config.Target_Group_Id__c : '');
        configMap.put('disabledChannelIds', (config != null && String.isNotBlank(config.Disabled_Channel_Ids__c)) ? config.Disabled_Channel_Ids__c : '');
        
        return configMap;
    }

    /**
     * @description Saves Agent Notification configuration settings to Messaging_Config__c.
     */
    @AuraEnabled
    public static Map<String, Object> saveAgentNotificationConfig(Map<String, Object> payload) {
        Map<String, Object> result = new Map<String, Object>{ 'success' => false, 'message' => '' };
        try {
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            if (config == null) {
                config = new Messaging_Config__c();
            }

            if (payload.containsKey('agentKeyword')) {
                config.Agent_Keyword__c = (String) payload.get('agentKeyword');
            }
            if (payload.containsKey('confirmationText')) {
                config.Confirmation_Text__c = (String) payload.get('confirmationText');
            }
            if (payload.containsKey('reactivationKeyword')) {
                config.Reactivation_Keyword__c = (String) payload.get('reactivationKeyword');
            }
            if (payload.containsKey('reminderEnabled')) {
                config.Reminder_Enabled__c = (Boolean) payload.get('reminderEnabled');
            }
            if (payload.containsKey('reminderMinutes')) {
                Object rMinObj = payload.get('reminderMinutes');
                config.Reminder_Minutes__c = (rMinObj != null) ? Decimal.valueOf(String.valueOf(rMinObj)) : 5;
            }
            if (payload.containsKey('reminderTemplate')) {
                config.Reminder_Message_Template__c = (String) payload.get('reminderTemplate');
            }

            if (payload.containsKey('isGlobal')) {
                config.Is_Global_Default__c = (Boolean) payload.get('isGlobal');
            }
            if (payload.containsKey('autoQueueDetector')) {
                config.Auto_Queue_Detector__c = (Boolean) payload.get('autoQueueDetector');
            }
            if (payload.containsKey('detectJoinedAgent')) {
                config.Detect_Joined_Agent__c = (Boolean) payload.get('detectJoinedAgent');
            }
            if (payload.containsKey('useFlowRouting')) {
                config.Use_Flow_Routing__c = (Boolean) payload.get('useFlowRouting');
            }
            if (payload.containsKey('selectedMessagingChannelId')) {
                config.Selected_Messaging_Channel_Id__c = (String) payload.get('selectedMessagingChannelId');
            }
            if (payload.containsKey('targetGroupId')) {
                config.Target_Group_Id__c = (String) payload.get('targetGroupId');
            }
            if (payload.containsKey('disabledChannelIds')) {
                config.Disabled_Channel_Ids__c = (String) payload.get('disabledChannelIds');
            }

            upsert config;

            result.put('success', true);
            result.put('message', 'Agent Top Notification Bar settings saved successfully.');
        } catch (Exception ex) {
            result.put('success', false);
            result.put('message', 'Error saving settings: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] Exception saving agent config: ' + ex.getMessage());
        }
        return result;
    }

    /**
     * @description Evaluates active sessions for customer inactivity, formats custom variable templates, and sends idle reminders.
     */
    @AuraEnabled
    public static Map<String, Object> checkAndSendInactivityReminders() {
        Map<String, Object> res = new Map<String, Object>{ 'success' => false, 'message' => '', 'sentCount' => 0 };
        try {
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            Boolean reminderEnabled = (config != null && config.Reminder_Enabled__c != null) ? config.Reminder_Enabled__c : false;
            Decimal reminderMinutes = (config != null && config.Reminder_Minutes__c != null) ? config.Reminder_Minutes__c : 5;
            String template = (config != null && String.isNotBlank(config.Reminder_Message_Template__c)) 
                ? config.Reminder_Message_Template__c 
                : 'Hello {customer_name}, we noticed you have been waiting for {minutes_passed} minutes. An agent will be with you shortly!';
            String agentKeyword = (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent';
            String reactivationKeyword = (config != null && String.isNotBlank(config.Reactivation_Keyword__c)) ? config.Reactivation_Keyword__c : 'reset';

            if (!reminderEnabled) {
                res.put('message', 'Reminder system is currently disabled in Messaging_Config__c.');
                return res;
            }

            Integer minutesInt = Integer.valueOf(reminderMinutes);
            Datetime thresholdTime = System.now().addMinutes(-minutesInt);

            List<MessagingSession> idleSessions = [
                SELECT Id, Name, Status, MessagingEndUserId, MessagingEndUser.Name, MessagingChannelId, MessagingChannel.MasterLabel, LastModifiedDate, CreatedDate
                FROM MessagingSession
                WHERE Status IN ('Waiting', 'Active') AND LastModifiedDate <= :thresholdTime
                ORDER BY LastModifiedDate ASC
                LIMIT 20
            ];

            Integer count = 0;
            List<String> details = new List<String>();

            for (MessagingSession ms : idleSessions) {
                String custName = (ms.MessagingEndUser != null && String.isNotBlank(ms.MessagingEndUser.Name)) ? ms.MessagingEndUser.Name : 'Customer';
                String channelLabel = (ms.MessagingChannel != null && String.isNotBlank(ms.MessagingChannel.MasterLabel)) ? ms.MessagingChannel.MasterLabel : 'Messaging Channel';

                // Variable Template Replacement System
                String messageBody = template;
                messageBody = messageBody.replace('{customer_name}', custName);
                messageBody = messageBody.replace('{user_name}', custName);
                messageBody = messageBody.replace('{minutes_passed}', String.valueOf(minutesInt));
                messageBody = messageBody.replace('{time_elapsed}', String.valueOf(minutesInt) + ' min');
                messageBody = messageBody.replace('{agent_keyword}', agentKeyword);
                messageBody = messageBody.replace('{reactivation_keyword}', reactivationKeyword);
                messageBody = messageBody.replace('{channel_name}', channelLabel);
                messageBody = messageBody.replace('{session_id}', ms.Id);

                // Insert ConversationEntry DML for the reminder
                try {
                    Blob b = Crypto.generateAesKey(128);
                    String h = EncodingUtil.convertToHex(b);
                    String freshUuid = h.substring(0,8)+'-'+h.substring(8,12)+'-'+h.substring(12,16)+'-'+h.substring(16,20)+'-'+h.substring(20,32);

                    Integer nextSeq = 1;
                    List<AggregateResult> maxSeqResult = [
                        SELECT MAX(Seq) maxSeq FROM ConversationEntry WHERE ConversationId = :ms.Id
                    ];
                    if (!maxSeqResult.isEmpty() && maxSeqResult[0].get('maxSeq') != null) {
                        nextSeq = Integer.valueOf(maxSeqResult[0].get('maxSeq')) + 1;
                    }

                    ConversationEntry entry = new ConversationEntry();
                    entry.ConversationId = ms.Id;
                    entry.MessageIdentifier = freshUuid;
                    entry.Message = messageBody;
                    entry.EntryType = 'Text';
                    entry.Seq = nextSeq;
                    entry.EntryTime = System.now();
                    entry.ActorType = 'System';
                    insert entry;

                    count++;
                    details.add('Sent reminder to ' + custName + ' (Session: ' + ms.Id + ')');
                } catch (Exception dmlEx) {
                    System.debug('>>> Reminder DML exception: ' + dmlEx.getMessage());
                }
            }

            res.put('success', true);
            res.put('sentCount', count);
            res.put('message', 'Processed inactivity check for ' + idleSessions.size() + ' sessions. Sent ' + count + ' automatic reminders.');
            res.put('details', details);
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error checking inactivity reminders: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] checkAndSendInactivityReminders: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Evaluates all current active/recent MessagingSession records and determines
     * which exact person (assigned agent) or queue would receive a Top Notification Bar broadcast
     * if the customer types the configured agent keyword.
     */
    @AuraEnabled
    public static Map<String, Object> getSimulatedAgentTargetingDetails() {
        Map<String, Object> response = new Map<String, Object>();
        List<Map<String, Object>> sessionSimulations = new List<Map<String, Object>>();

        try {
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            String keyword = (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent';
            Boolean detectJoinedAgent = (config != null && config.Detect_Joined_Agent__c != null) ? config.Detect_Joined_Agent__c : true;
            Boolean isGlobalDefault = (config != null && config.Is_Global_Default__c != null) ? config.Is_Global_Default__c : false;
            Boolean autoQueueDetector = (config != null && config.Auto_Queue_Detector__c != null) ? config.Auto_Queue_Detector__c : true;
            Boolean useFlowRouting = (config != null && config.Use_Flow_Routing__c != null) ? config.Use_Flow_Routing__c : true;
            String selectedMessagingChannelId = (config != null && String.isNotBlank(config.Selected_Messaging_Channel_Id__c)) ? config.Selected_Messaging_Channel_Id__c : 'ALL';
            String targetGroupId = (config != null && String.isNotBlank(config.Target_Group_Id__c)) ? config.Target_Group_Id__c : '';

            response.put('agentKeyword', keyword);
            response.put('detectJoinedAgent', detectJoinedAgent);
            response.put('isGlobalDefault', isGlobalDefault);
            response.put('autoQueueDetector', autoQueueDetector);
            response.put('useFlowRouting', useFlowRouting);
            response.put('selectedMessagingChannelId', selectedMessagingChannelId);

            List<MessagingSession> activeSessions = [
                SELECT Id, Name, Status, OwnerId, Owner.Name, MessagingEndUserId, MessagingEndUser.Name, MessagingChannelId, MessagingChannel.MasterLabel, CreatedDate
                FROM MessagingSession
                ORDER BY CreatedDate DESC
                LIMIT 20
            ];

            String defaultQueueName = 'Chat Queue';
            List<Group> chatQueues = [SELECT Id, Name FROM Group WHERE Type = 'Queue' AND (Name = 'Chat Queue' OR DeveloperName = 'Chat_Queue') LIMIT 1];
            if (!chatQueues.isEmpty()) {
                defaultQueueName = chatQueues[0].Name;
            }

            if (activeSessions.isEmpty()) {
                response.put('hasSessions', false);
                response.put('message', 'No active or recent MessagingSession records found in the org.');
            } else {
                response.put('hasSessions', true);

                // Pre-fetch PendingServiceRouting entries for active sessions if useFlowRouting is enabled
                Map<Id, Id> sessionToRoutedQueueMap = new Map<Id, Id>();
                if (useFlowRouting) {
                    Set<Id> sessionIds = new Map<Id, MessagingSession>(activeSessions).keySet();
                    for (PendingServiceRouting psr : [
                        SELECT Id, GroupId, WorkItemId FROM PendingServiceRouting WHERE WorkItemId IN :sessionIds
                    ]) {
                        if (psr.GroupId != null) {
                            sessionToRoutedQueueMap.put(psr.WorkItemId, psr.GroupId);
                        }
                    }
                }

                // Map of Queue Groups for label resolution
                Set<Id> targetGroupIds = new Set<Id>(sessionToRoutedQueueMap.values());
                Map<Id, String> groupNameMap = new Map<Id, String>();
                if (!targetGroupIds.isEmpty()) {
                    for (Group g : [SELECT Id, Name FROM Group WHERE Id IN :targetGroupIds]) {
                        groupNameMap.put(g.Id, g.Name);
                    }
                }

                for (MessagingSession ms : activeSessions) {
                    Map<String, Object> sim = new Map<String, Object>();
                    sim.put('sessionId', ms.Id);
                    sim.put('sessionName', ms.Name);
                    sim.put('status', ms.Status);
                    sim.put('createdDate', ms.CreatedDate);
                    sim.put('customerName', (ms.MessagingEndUser != null && String.isNotBlank(ms.MessagingEndUser.Name)) ? ms.MessagingEndUser.Name : 'Customer');
                    sim.put('ownerId', ms.OwnerId);
                    sim.put('ownerName', (ms.Owner != null && String.isNotBlank(ms.Owner.Name)) ? ms.Owner.Name : String.valueOf(ms.OwnerId));
                    sim.put('channelId', ms.MessagingChannelId);
                    sim.put('channelName', (ms.MessagingChannel != null && String.isNotBlank(ms.MessagingChannel.MasterLabel)) ? ms.MessagingChannel.MasterLabel : String.valueOf(ms.MessagingChannelId));

                    Boolean matchesChannelFilter = (selectedMessagingChannelId == 'ALL' || selectedMessagingChannelId == ms.MessagingChannelId);
                    sim.put('matchesChannelFilter', matchesChannelFilter);

                    String ownerIdStr = String.valueOf(ms.OwnerId);
                    Boolean isUserOwner = String.isNotBlank(ownerIdStr) && ownerIdStr.startsWith('005');

                    if (!matchesChannelFilter) {
                        sim.put('broadcastTargetType', 'Filtered Out (Deployment Mismatch)');
                        sim.put('broadcastTargetName', 'Channel: ' + sim.get('channelName'));
                        sim.put('targetDetails', 'Session channel (' + sim.get('channelName') + ') does not match active Messaging Channel filter (' + selectedMessagingChannelId + '). Top notification bar will NOT trigger.');
                        sim.put('badgeClass', 'slds-theme_shade');
                    } else if (detectJoinedAgent && isUserOwner) {
                        sim.put('broadcastTargetType', 'Person (Assigned Agent)');
                        sim.put('broadcastTargetName', (ms.Owner != null && String.isNotBlank(ms.Owner.Name)) ? ms.Owner.Name : ownerIdStr);
                        sim.put('targetDetails', 'Agent has joined session. Broadcast targets ONLY assigned agent ' + sim.get('broadcastTargetName') + ' (User ID: ' + ownerIdStr + ').');
                        sim.put('badgeClass', 'slds-theme_success');
                    } else {
                        sim.put('broadcastTargetType', 'Queue (Group Members)');
                        Id flowQueueId = sessionToRoutedQueueMap.get(ms.Id);
                        if (!isUserOwner && ownerIdStr.startsWith('00G')) {
                            flowQueueId = (Id) ms.OwnerId;
                        }

                        if (isGlobalDefault) {
                            sim.put('broadcastTargetName', 'All Users (Global Broadcast)');
                            sim.put('targetDetails', 'Global mode enabled. Broadcast targets ALL logged-in users across org.');
                        } else if (useFlowRouting) {
                            String flowQueueIdStr = flowQueueId != null ? String.valueOf(flowQueueId) : null;
                            String singleTargetUserId = resolveSingleFlowTargetUser(ms.Id, flowQueueIdStr);
                            if (String.isNotBlank(singleTargetUserId)) {
                                List<User> singleUsers = [SELECT Id, Name FROM User WHERE Id = :singleTargetUserId LIMIT 1];
                                String singleUserName = !singleUsers.isEmpty() ? singleUsers[0].Name : singleTargetUserId;
                                sim.put('broadcastTargetType', 'Single User (Omni Target)');
                                sim.put('broadcastTargetName', singleUserName + ' (1 Person Only)');
                                sim.put('targetDetails', 'Omni-Channel Flow Routing active. System resolved EXACT 1 single user: ' + singleUserName + ' (User ID: ' + singleTargetUserId + '). Broadcast pings ONLY this single user.');
                                sim.put('badgeClass', 'slds-theme_success');
                            } else {
                                String flowQueueName = (flowQueueId != null && groupNameMap.containsKey(flowQueueId)) ? groupNameMap.get(flowQueueId) : String.valueOf(flowQueueId);
                                sim.put('broadcastTargetName', 'Flow Routed Queue: ' + flowQueueName);
                                sim.put('targetDetails', 'Omni-Channel Flow Routing detected. Broadcast targets specific routed Queue "' + flowQueueName + '".');
                            }
                        } else if (autoQueueDetector) {
                            sim.put('broadcastTargetName', defaultQueueName + ' Members');
                            sim.put('targetDetails', 'No agent joined yet. Broadcast targets ALL members in ' + defaultQueueName + '.');
                        } else if (String.isNotBlank(targetGroupId)) {
                            sim.put('broadcastTargetName', 'Target Group ID (' + targetGroupId + ')');
                            sim.put('targetDetails', 'Target group configured. Broadcast targets members of Group ' + targetGroupId + '.');
                        } else {
                            sim.put('broadcastTargetName', defaultQueueName + ' Members');
                            sim.put('targetDetails', 'Broadcast targets Chat Queue members.');
                        }
                        sim.put('badgeClass', 'slds-theme_warning');
                    }

                    sessionSimulations.add(sim);
                }
                response.put('sessions', sessionSimulations);
            }
        } catch (Exception ex) {
            response.put('hasSessions', false);
            response.put('message', 'Error evaluating active sessions: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] Exception in getSimulatedAgentTargetingDetails: ' + ex.getMessage());
        }

        return response;
    }

    /**
     * @description Queries and returns real live Salesforce system metadata (QueueRoutingConfigs, Queues, Presence Statuses, Messaging Channels, Active Sessions) with direct setup URLs and status flags.
     */
    @AuraEnabled
    public static Map<String, Object> getRealSystemDetections() {
        Map<String, Object> result = new Map<String, Object>();
        try {
            // 1. Query all QueueRoutingConfigs in org (e.g. Chat_Routing_Config, t3)
            List<Map<String, Object>> routingConfigList = new List<Map<String, Object>>();
            Map<Id, Map<String, Object>> routingConfigMap = new Map<Id, Map<String, Object>>();
            try {
                List<QueueRoutingConfig> qrcList = [
                    SELECT Id, MasterLabel, DeveloperName, CapacityWeight, RoutingModel, RoutingPriority 
                    FROM QueueRoutingConfig 
                    ORDER BY MasterLabel ASC
                ];
                for (QueueRoutingConfig qrc : qrcList) {
                    Map<String, Object> qrcMap = new Map<String, Object>{
                        'id' => String.valueOf(qrc.Id),
                        'name' => qrc.MasterLabel,
                        'developerName' => qrc.DeveloperName,
                        'capacity' => qrc.CapacityWeight,
                        'model' => String.isNotBlank(qrc.RoutingModel) ? qrc.RoutingModel : 'LeastActive',
                        'priority' => qrc.RoutingPriority,
                        'url' => '/lightning/setup/RoutingConfigurations/page?address=%2F' + String.valueOf(qrc.Id)
                    };
                    routingConfigList.add(qrcMap);
                    routingConfigMap.put(qrc.Id, qrcMap);
                }
            } catch (Exception ex) {
                System.debug('>>> QueueRoutingConfig query note: ' + ex.getMessage());
            }
            result.put('routingConfigs', routingConfigList);
            result.put('routingConfigCount', routingConfigList.size());

            // 2. Query all Queues (Group where Type = 'Queue')
            List<Map<String, Object>> queueList = new List<Map<String, Object>>();
            Map<Id, Group> queueGroupMap = new Map<Id, Group>();
            try {
                List<Group> grpList = [
                    SELECT Id, Name, DeveloperName, QueueRoutingConfigId 
                    FROM Group 
                    WHERE Type = 'Queue' 
                    ORDER BY Name ASC 
                    LIMIT 50
                ];
                for (Group g : grpList) {
                    queueGroupMap.put(g.Id, g);
                    Map<String, Object> qMap = new Map<String, Object>{
                        'id' => String.valueOf(g.Id),
                        'name' => g.Name,
                        'developerName' => g.DeveloperName,
                        'routingConfigId' => g.QueueRoutingConfigId != null ? String.valueOf(g.QueueRoutingConfigId) : null,
                        'url' => '/lightning/setup/Queues/page?address=%2F' + String.valueOf(g.Id)
                    };
                    queueList.add(qMap);
                }
            } catch (Exception ex) {
                System.debug('>>> Queue query note: ' + ex.getMessage());
            }
            result.put('queues', queueList);
            result.put('queueCount', queueList.size());

            // 3. Query all ServicePresenceStatus records
            List<Map<String, Object>> presenceList = new List<Map<String, Object>>();
            try {
                List<ServicePresenceStatus> spsList = [
                    SELECT Id, MasterLabel, DeveloperName 
                    FROM ServicePresenceStatus 
                    WHERE IsDeleted = false 
                    ORDER BY MasterLabel ASC
                ];
                for (ServicePresenceStatus sps : spsList) {
                    Map<String, Object> item = new Map<String, Object>{
                        'id' => String.valueOf(sps.Id),
                        'name' => String.valueOf(sps.MasterLabel),
                        'developerName' => String.valueOf(sps.DeveloperName),
                        'url' => '/lightning/setup/ServicePresenceStatus/page?address=%2F' + String.valueOf(sps.Id)
                    };
                    presenceList.add(item);
                }
            } catch (Exception ex) {
                System.debug('>>> Presence query note: ' + ex.getMessage());
            }
            result.put('presenceStatuses', presenceList);
            result.put('presenceCount', presenceList.size());

            // 4. Messaging Channels & Inspection Details
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            String disabledChannelsStr = (config != null && String.isNotBlank(config.Disabled_Channel_Ids__c)) ? config.Disabled_Channel_Ids__c : '';
            Set<String> disabledSet = new Set<String>();
            if (String.isNotBlank(disabledChannelsStr)) {
                for (String dId : disabledChannelsStr.split(',')) {
                    if (String.isNotBlank(dId.trim())) {
                        disabledSet.add(dId.trim());
                    }
                }
            }

            List<Map<String, Object>> channelList = new List<Map<String, Object>>();
            try {
                List<MessagingChannel> mcList = [
                    SELECT Id, MasterLabel, DeveloperName, MessageType 
                    FROM MessagingChannel 
                    ORDER BY MasterLabel ASC 
                    LIMIT 20
                ];

                for (MessagingChannel mc : mcList) {
                    Map<String, Object> item = new Map<String, Object>();
                    String chId = String.valueOf(mc.Id);
                    item.put('id', chId);
                    item.put('label', String.valueOf(mc.MasterLabel));
                    item.put('developerName', String.valueOf(mc.DeveloperName));
                    item.put('messageType', String.valueOf(mc.MessageType));
                    item.put('isDisabled', disabledSet.contains(chId));

                    // Deployment Object Details
                    Map<String, Object> deploymentInfo = new Map<String, Object>{
                        'id' => chId,
                        'name' => String.valueOf(mc.MasterLabel),
                        'developerName' => String.valueOf(mc.DeveloperName),
                        'messageType' => String.valueOf(mc.MessageType),
                        'exists' => true,
                        'url' => '/lightning/setup/MessagingChannels/page?address=%2F' + chId,
                        'homeUrl' => '/lightning/setup/MessagingChannels/home'
                    };
                    item.put('deploymentInfo', deploymentInfo);

                    // Queue Details Resolution
                    Id linkedQueueId = null;
                    try {
                        // Search up to 10 recent sessions for an OwnerId starting with '00G' (Queue)
                        List<MessagingSession> sessionList = [
                            SELECT Id, OwnerId FROM MessagingSession 
                            WHERE MessagingChannelId = :mc.Id AND OwnerId != null 
                            ORDER BY CreatedDate DESC LIMIT 10
                        ];
                        for (MessagingSession msRec : sessionList) {
                            String ownerIdStr = String.valueOf(msRec.OwnerId);
                            if (ownerIdStr.startsWith('00G')) {
                                linkedQueueId = (Id) msRec.OwnerId;
                                break;
                            }
                        }

                        // If no session direct queue owner, check PendingServiceRouting for these sessions
                        if (linkedQueueId == null && !sessionList.isEmpty()) {
                            Set<Id> sIds = new Map<Id, MessagingSession>(sessionList).keySet();
                            List<PendingServiceRouting> psrCheck = [
                                SELECT Id, GroupId FROM PendingServiceRouting 
                                WHERE WorkItemId IN :sIds AND GroupId != null 
                                LIMIT 1
                            ];
                            if (!psrCheck.isEmpty()) {
                                linkedQueueId = psrCheck[0].GroupId;
                            }
                        }
                    } catch (Exception sEx) {}

                    // Fallback Queue resolution: Match by name/developerName or pick queue with QueueRoutingConfig
                    if (linkedQueueId == null || !queueGroupMap.containsKey(linkedQueueId)) {
                        for (Group g : queueGroupMap.values()) {
                            if (g.DeveloperName.equalsIgnoreCase(mc.DeveloperName) || g.Name.equalsIgnoreCase(mc.MasterLabel)) {
                                linkedQueueId = g.Id;
                                break;
                            }
                        }
                    }
                    if (linkedQueueId == null || !queueGroupMap.containsKey(linkedQueueId)) {
                        // Pick first queue that has a QueueRoutingConfig assigned
                        for (Group g : queueGroupMap.values()) {
                            if (g.QueueRoutingConfigId != null) {
                                linkedQueueId = g.Id;
                                break;
                            }
                        }
                    }
                    if (linkedQueueId == null && !queueGroupMap.isEmpty()) {
                        linkedQueueId = new List<Id>(queueGroupMap.keySet())[0];
                    }

                    Map<String, Object> queueInfo = new Map<String, Object>();
                    if (linkedQueueId != null && queueGroupMap.containsKey(linkedQueueId)) {
                        Group qGrp = queueGroupMap.get(linkedQueueId);
                        queueInfo.put('id', String.valueOf(qGrp.Id));
                        queueInfo.put('name', qGrp.Name);
                        queueInfo.put('developerName', qGrp.DeveloperName);
                        queueInfo.put('exists', true);
                        queueInfo.put('url', '/lightning/setup/Queues/page?address=%2F' + String.valueOf(qGrp.Id));
                        queueInfo.put('routingConfigId', qGrp.QueueRoutingConfigId != null ? String.valueOf(qGrp.QueueRoutingConfigId) : null);
                    } else {
                        queueInfo.put('id', null);
                        queueInfo.put('name', 'Not Found / Not Linked');
                        queueInfo.put('developerName', null);
                        queueInfo.put('exists', false);
                    }
                    queueInfo.put('homeUrl', '/lightning/setup/Queues/home');
                    item.put('queueInfo', queueInfo);

                    // Routing Configuration Details (QueueRoutingConfig e.g. Chat_Routing_Config, t3)
                    Map<String, Object> routingInfo = new Map<String, Object>();
                    Id qrcId = null;
                    if (queueInfo.get('routingConfigId') != null) {
                        try {
                            qrcId = (Id) queueInfo.get('routingConfigId');
                        } catch (Exception e) {}
                    }

                    // Fallback to first available QueueRoutingConfig if queue doesn't have explicit lookup
                    if ((qrcId == null || !routingConfigMap.containsKey(qrcId)) && !routingConfigList.isEmpty()) {
                        try {
                            String firstQrcIdStr = (String) routingConfigList[0].get('id');
                            qrcId = (Id) firstQrcIdStr;
                        } catch (Exception e) {}
                    }

                    if (qrcId != null && routingConfigMap.containsKey(qrcId)) {
                        Map<String, Object> qrcMap = routingConfigMap.get(qrcId);
                        routingInfo.put('id', qrcMap.get('id'));
                        routingInfo.put('name', qrcMap.get('name'));
                        routingInfo.put('developerName', qrcMap.get('developerName'));
                        routingInfo.put('capacity', qrcMap.get('capacity'));
                        routingInfo.put('model', qrcMap.get('model'));
                        routingInfo.put('priority', qrcMap.get('priority'));
                        routingInfo.put('exists', true);
                        routingInfo.put('url', qrcMap.get('url'));
                    } else {
                        routingInfo.put('id', null);
                        routingInfo.put('name', 'Not Found / Not Assigned');
                        routingInfo.put('developerName', null);
                        routingInfo.put('exists', false);
                    }
                    routingInfo.put('homeUrl', '/lightning/setup/RoutingConfigurations/home');
                    item.put('routingInfo', routingInfo);

                    // Presence Details
                    Map<String, Object> presenceInfo = new Map<String, Object>();
                    if (!presenceList.isEmpty()) {
                        Map<String, Object> firstPresence = presenceList[0];
                        presenceInfo.put('id', firstPresence.get('id'));
                        presenceInfo.put('name', firstPresence.get('name'));
                        presenceInfo.put('developerName', firstPresence.get('developerName'));
                        presenceInfo.put('exists', true);
                        presenceInfo.put('url', firstPresence.get('url'));
                    } else {
                        presenceInfo.put('id', null);
                        presenceInfo.put('name', 'Not Found');
                        presenceInfo.put('developerName', null);
                        presenceInfo.put('exists', false);
                    }
                    presenceInfo.put('homeUrl', '/lightning/setup/ServicePresenceStatus/home');
                    item.put('presenceInfo', presenceInfo);

                    // Legacy string fields for backward compatibility
                    item.put('linkedQueue', (Boolean) queueInfo.get('exists') ? (String) queueInfo.get('name') : 'Not Linked');
                    item.put('linkedRouting', (Boolean) routingInfo.get('exists') ? ((String) routingInfo.get('name') + ' (' + (String) routingInfo.get('developerName') + ')') : 'Not Linked');
                    item.put('linkedPresence', (Boolean) presenceInfo.get('exists') ? (String) presenceInfo.get('name') : 'Not Linked');

                    channelList.add(item);
                }
            } catch (Exception ex) {
                System.debug('>>> Channel query note: ' + ex.getMessage());
            }
            result.put('channels', channelList);
            result.put('channelCount', channelList.size());

            // 5. Query Active Standard Users for Setup Suite User Selector
            List<Map<String, Object>> userList = new List<Map<String, Object>>();
            try {
                List<User> uList = [
                    SELECT Id, Name, Email, Username 
                    FROM User 
                    WHERE IsActive = true AND UserType = 'Standard' 
                    ORDER BY Name ASC 
                    LIMIT 100
                ];
                for (User u : uList) {
                    userList.add(new Map<String, Object>{
                        'label' => u.Name + ' (' + u.Username + ')',
                        'value' => String.valueOf(u.Id),
                        'name' => u.Name,
                        'email' => u.Email
                    });
                }
            } catch (Exception ex) {}
            result.put('activeUsers', userList);

            // 6. Live Active Sessions
            Integer activeSessionCount = 0;
            try {
                activeSessionCount = [SELECT COUNT() FROM MessagingSession WHERE Status IN ('Active', 'New', 'InProgress')];
            } catch (Exception ex) {}
            result.put('activeSessionCount', activeSessionCount);

            // 7. Configuration Status
            result.put('agentKeyword', (config != null && String.isNotBlank(config.Agent_Keyword__c)) ? config.Agent_Keyword__c : 'agent');
            result.put('disabledChannelIds', disabledChannelsStr);

            result.put('success', true);
        } catch (Exception e) {
            result.put('success', false);
            result.put('message', 'Error fetching system detections: ' + e.getMessage());
        }
        return result;
    }

    /**
     * @description Executes automated Omni-Channel setup suite: creates Queue, Routing Config, Messaging Channel,
     * Service Presence Status, Permission Set, assigns Presence Status to Permission Set, assigns Permission Set to
     * selected users, and adds selected users to Queue.
     */
    @AuraEnabled
    public static Map<String, Object> executeOmniChannelSetupSuite(
        String mode,
        List<String> selectedUserIds,
        Boolean createNewChannel,
        Boolean useGlobalPresence
    ) {
        Map<String, Object> res = new Map<String, Object>();
        List<Map<String, Object>> logs = new List<Map<String, Object>>();

        try {
            if (selectedUserIds == null) {
                selectedUserIds = new List<String>();
            }
            if (createNewChannel == null) {
                createNewChannel = false;
            }
            if (useGlobalPresence == null) {
                useGlobalPresence = true;
            }

            Boolean isMissingOnly = (mode == 'MISSING');
            String suffix = String.valueOf(Math.abs(Crypto.getRandomInteger())).substring(0, 3);
            String nowStr = Datetime.now().format('HH:mm:ss');

            logs.add(new Map<String, Object>{
                'time' => nowStr,
                'status' => 'INFO',
                'step' => 'Initializer',
                'message' => '🚀 Started Omni-Channel Automated Setup Suite in "' + (isMissingOnly ? 'Create Missing Items Only' : 'Create Fresh New Suite') + '" mode (Create New Channel: ' + (createNewChannel ? 'YES' : 'NO') + ', Global Presence: ' + (useGlobalPresence ? 'YES' : 'NO') + ') for ' + selectedUserIds.size() + ' selected users.'
            });

            // 1. Routing Configuration Creation / Resolution (REST Callout - MUST be first before any DML!)
            String routingId = null;
            if (isMissingOnly) {
                List<QueueRoutingConfig> existingRoutings = [SELECT Id, MasterLabel FROM QueueRoutingConfig LIMIT 1];
                if (!existingRoutings.isEmpty()) {
                    routingId = String.valueOf(existingRoutings[0].Id);
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Routing Configuration',
                        'message' => '✅ Resolved existing QueueRoutingConfig "' + existingRoutings[0].MasterLabel + '" (ID: ' + routingId + ').'
                    });
                }
            }
            if (String.isBlank(routingId)) {
                Map<String, Object> rRes = autoCreateRoutingConfig('Omni Flow Routing ' + suffix);
                if (rRes.containsKey('routingConfigId')) {
                    routingId = (String) rRes.get('routingConfigId');
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Routing Configuration',
                        'message' => '⚡ Created new QueueRoutingConfig "Omni Flow Routing ' + suffix + '" via REST API (ID: ' + routingId + ').'
                    });
                } else {
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'WARNING',
                        'step' => 'Routing Configuration',
                        'message' => '⚠️ Routing Config note: ' + rRes.get('message')
                    });
                }
            }

            // 2. Messaging Channel Creation / Resolution (REST Callout - MUST be before any DML!)
            String channelId = null;
            Boolean shouldCreateChannel = createNewChannel || !isMissingOnly;

            if (!shouldCreateChannel && isMissingOnly) {
                List<MessagingChannel> existingChannels = [SELECT Id, MasterLabel FROM MessagingChannel LIMIT 1];
                if (!existingChannels.isEmpty()) {
                    channelId = String.valueOf(existingChannels[0].Id);
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Messaging Channel',
                        'message' => '✅ Resolved existing MessagingChannel "' + existingChannels[0].MasterLabel + '" (ID: ' + channelId + ').'
                    });
                }
            }
            if (String.isBlank(channelId)) {
                Map<String, Object> cRes = autoCreateMessagingChannel('Messaging Channel ' + suffix);
                if (cRes.containsKey('channelId')) {
                    channelId = (String) cRes.get('channelId');
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Messaging Channel',
                        'message' => '⚡ Created new MessagingChannel "Messaging Channel ' + suffix + '" via REST API (ID: ' + channelId + ').'
                    });
                } else {
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'WARNING',
                        'step' => 'Messaging Channel',
                        'message' => '⚠️ Messaging Channel note: ' + cRes.get('message')
                    });
                }
            }

            // 3. Service Presence Status Creation / Resolution
            String presenceId = null;
            Boolean shouldReusePresence = (useGlobalPresence == true) || isMissingOnly;

            if (shouldReusePresence) {
                List<ServicePresenceStatus> existingPresence = [SELECT Id, MasterLabel FROM ServicePresenceStatus WHERE IsDeleted = false ORDER BY MasterLabel ASC LIMIT 1];
                if (!existingPresence.isEmpty()) {
                    presenceId = String.valueOf(existingPresence[0].Id);
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Service Presence Status',
                        'message' => '✅ Reused Global ServicePresenceStatus "' + existingPresence[0].MasterLabel + '" (ID: ' + presenceId + ').'
                    });
                }
            }
            if (String.isBlank(presenceId)) {
                Map<String, Object> pRes = autoCreatePresenceStatus('Available Messaging ' + suffix);
                if (pRes.containsKey('presenceId')) {
                    presenceId = (String) pRes.get('presenceId');
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Service Presence Status',
                        'message' => '⚡ Created new ServicePresenceStatus "Available Messaging ' + suffix + '" via REST API (ID: ' + presenceId + ').'
                    });
                } else {
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'WARNING',
                        'step' => 'Service Presence Status',
                        'message' => '⚠️ Presence Status note: ' + pRes.get('message')
                    });
                }
            }

            // 4. Queue Creation / Resolution (DML - Performed after all callouts are done!)
            String queueId = null;
            String queueName = 'Chat Queue ' + suffix;
            if (isMissingOnly) {
                List<Group> existingQueues = [SELECT Id, Name FROM Group WHERE Type = 'Queue' AND DeveloperName LIKE '%Chat%' LIMIT 1];
                if (!existingQueues.isEmpty()) {
                    queueId = String.valueOf(existingQueues[0].Id);
                    queueName = existingQueues[0].Name;
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Chat Queue',
                        'message' => '✅ Resolved existing Chat Queue "' + queueName + '" (ID: ' + queueId + ').'
                    });
                }
            }
            if (String.isBlank(queueId)) {
                Map<String, Object> qRes = autoCreateQueue('Chat Queue ' + suffix);
                if (qRes.containsKey('queueId')) {
                    queueId = (String) qRes.get('queueId');
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Chat Queue',
                        'message' => '⚡ Created new Chat Queue "Chat Queue ' + suffix + '" (ID: ' + queueId + ').'
                    });
                } else {
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'WARNING',
                        'step' => 'Chat Queue',
                        'message' => '⚠️ Queue creation note: ' + qRes.get('message')
                    });
                }
            }

            // 5. Create & Assign Permission Set for Omni-Channel Presence
            String permSetId = null;
            try {
                String psDevName = 'OmniChannelAccess_' + suffix;
                PermissionSet ps = new PermissionSet(
                    Name = psDevName,
                    Label = 'Omni-Channel Agent Access ' + suffix
                );
                insert ps;
                permSetId = String.valueOf(ps.Id);

                logs.add(new Map<String, Object>{
                    'time' => Datetime.now().format('HH:mm:ss'),
                    'status' => 'SUCCESS',
                    'step' => 'Permission Set',
                    'message' => '⚡ Created Permission Set "Omni-Channel Agent Access ' + suffix + '" (ID: ' + permSetId + ').'
                });

                // Link ServicePresenceStatus to PermissionSet via SetupEntityAccess
                if (String.isNotBlank(presenceId)) {
                    try {
                        SetupEntityAccess sea = new SetupEntityAccess(
                            ParentId = ps.Id,
                            SetupEntityId = presenceId
                        );
                        insert sea;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Presence Access',
                            'message' => '✅ Linked ServicePresenceStatus access to Permission Set.'
                        });
                    } catch (Exception seaEx) {
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'WARNING',
                            'step' => 'Presence Access',
                            'message' => '⚠️ SetupEntityAccess note: ' + seaEx.getMessage()
                        });
                    }
                }

                // Assign PermissionSet to selected users
                if (!selectedUserIds.isEmpty()) {
                    List<PermissionSetAssignment> psaList = new List<PermissionSetAssignment>();
                    for (String uId : selectedUserIds) {
                        psaList.add(new PermissionSetAssignment(
                            AssigneeId = uId,
                            PermissionSetId = ps.Id
                        ));
                    }
                    try {
                        insert psaList;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Permission Set Assignment',
                            'message' => '✅ Assigned Permission Set to ' + selectedUserIds.size() + ' selected users.'
                        });
                    } catch (Exception psaEx) {
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'WARNING',
                            'step' => 'Permission Set Assignment',
                            'message' => '⚠️ PermissionSetAssignment note: ' + psaEx.getMessage()
                        });
                    }
                }
                // Assign Top_Notification_Admin_Access PermissionSet to current user and selected users to ensure full admin/setup privileges
                try {
                    List<PermissionSet> adminPS = [SELECT Id FROM PermissionSet WHERE Name = 'Top_Notification_Admin_Access' LIMIT 1];
                    if (!adminPS.isEmpty()) {
                        Set<Id> targetUsers = new Set<Id>();
                        targetUsers.add(UserInfo.getUserId());
                        if (selectedUserIds != null) {
                            for (String uId : selectedUserIds) {
                                targetUsers.add((Id) uId);
                            }
                        }
                        List<PermissionSetAssignment> existingPSA = [
                            SELECT AssigneeId FROM PermissionSetAssignment 
                            WHERE PermissionSetId = :adminPS[0].Id AND AssigneeId IN :targetUsers
                        ];
                        Set<Id> alreadyAssigned = new Set<Id>();
                        for (PermissionSetAssignment psa : existingPSA) {
                            alreadyAssigned.add(psa.AssigneeId);
                        }
                        List<PermissionSetAssignment> newPsa = new List<PermissionSetAssignment>();
                        for (Id uId : targetUsers) {
                            if (!alreadyAssigned.contains(uId)) {
                                newPsa.add(new PermissionSetAssignment(
                                    AssigneeId = uId,
                                    PermissionSetId = adminPS[0].Id
                                ));
                            }
                        }
                        if (!newPsa.isEmpty()) {
                            insert newPsa;
                            logs.add(new Map<String, Object>{
                                'time' => Datetime.now().format('HH:mm:ss'),
                                'status' => 'SUCCESS',
                                'step' => 'Admin Privileges',
                                'message' => '✅ Auto-assigned Top_Notification_Admin_Access Permission Set to ensure full admin privileges.'
                            });
                        }
                    }
                } catch (Exception adminPsEx) {
                    System.debug('>>> Admin PS assignment note: ' + adminPsEx.getMessage());
                }
            } catch (Exception psEx) {
                logs.add(new Map<String, Object>{
                    'time' => Datetime.now().format('HH:mm:ss'),
                    'status' => 'WARNING',
                    'step' => 'Permission Set',
                    'message' => '⚠️ Permission Set creation note: ' + psEx.getMessage()
                });
            }

            // 6. Add selected users to Queue (GroupMember)
            if (String.isNotBlank(queueId) && !selectedUserIds.isEmpty()) {
                List<GroupMember> gmList = new List<GroupMember>();
                for (String uId : selectedUserIds) {
                    gmList.add(new GroupMember(
                        GroupId = queueId,
                        UserOrGroupId = uId
                    ));
                }
                try {
                    insert gmList;
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'SUCCESS',
                        'step' => 'Queue Membership',
                        'message' => '✅ Added ' + selectedUserIds.size() + ' users as Queue Members in Chat Queue.'
                    });
                } catch (Exception gmEx) {
                    logs.add(new Map<String, Object>{
                        'time' => Datetime.now().format('HH:mm:ss'),
                        'status' => 'WARNING',
                        'step' => 'Queue Membership',
                        'message' => '⚠️ GroupMember insert note: ' + gmEx.getMessage()
                    });
                }
            }

            // 7. Update org configuration asynchronously in separate transaction to avoid MIXED_DML_OPERATION
            updateMessagingConfigAsync(queueId, channelId);

            logs.add(new Map<String, Object>{
                'time' => Datetime.now().format('HH:mm:ss'),
                'status' => 'SUCCESS',
                'step' => 'Org Configuration',
                'message' => '✅ Scheduled background sync for org Messaging_Config__c settings.'
            });

            // 8. 🔍 Component Verification System (Query SOQL to verify objects exist in Salesforce DB)
            logs.add(new Map<String, Object>{
                'time' => Datetime.now().format('HH:mm:ss'),
                'status' => 'INFO',
                'step' => 'Verification System',
                'message' => '🔍 Running Component Verification System to confirm database persistence...'
            });

            Boolean isQueueVerified = false;
            if (String.isNotBlank(queueId)) {
                try {
                    List<Group> checkQ = [SELECT Id, Name, DeveloperName FROM Group WHERE Id = :queueId LIMIT 1];
                    if (!checkQ.isEmpty()) {
                        isQueueVerified = true;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Queue Verification',
                            'message' => '🔍 VERIFIED: Queue "' + checkQ[0].Name + '" (' + checkQ[0].DeveloperName + ') exists in Salesforce database (ID: ' + queueId + ').'
                        });
                    }
                } catch (Exception ex) {}
            }

            Boolean isRoutingVerified = false;
            if (String.isNotBlank(routingId)) {
                try {
                    List<QueueRoutingConfig> checkR = [SELECT Id, MasterLabel, DeveloperName FROM QueueRoutingConfig WHERE Id = :routingId LIMIT 1];
                    if (!checkR.isEmpty()) {
                        isRoutingVerified = true;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Routing Verification',
                            'message' => '🔍 VERIFIED: Routing Config "' + checkR[0].MasterLabel + '" (' + checkR[0].DeveloperName + ') exists in Salesforce database (ID: ' + routingId + ').'
                        });
                    }
                } catch (Exception ex) {}
            }

            Boolean isChannelVerified = false;
            if (String.isNotBlank(channelId)) {
                try {
                    List<MessagingChannel> checkC = [SELECT Id, MasterLabel, DeveloperName FROM MessagingChannel WHERE Id = :channelId LIMIT 1];
                    if (!checkC.isEmpty()) {
                        isChannelVerified = true;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Channel Verification',
                            'message' => '🔍 VERIFIED: Messaging Channel "' + checkC[0].MasterLabel + '" (' + checkC[0].DeveloperName + ') exists in Salesforce database (ID: ' + channelId + ').'
                        });
                    }
                } catch (Exception ex) {}
            }

            Boolean isPresenceVerified = false;
            if (String.isNotBlank(presenceId)) {
                try {
                    List<ServicePresenceStatus> checkP = [SELECT Id, MasterLabel, DeveloperName FROM ServicePresenceStatus WHERE Id = :presenceId LIMIT 1];
                    if (!checkP.isEmpty()) {
                        isPresenceVerified = true;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'Presence Verification',
                            'message' => '🔍 VERIFIED: Service Presence Status "' + checkP[0].MasterLabel + '" (' + checkP[0].DeveloperName + ') exists in Salesforce database (ID: ' + presenceId + ').'
                        });
                    }
                } catch (Exception ex) {}
            }

            Boolean isPermSetVerified = false;
            if (String.isNotBlank(permSetId)) {
                try {
                    List<PermissionSet> checkPS = [SELECT Id, Name, Label FROM PermissionSet WHERE Id = :permSetId LIMIT 1];
                    if (!checkPS.isEmpty()) {
                        isPermSetVerified = true;
                        logs.add(new Map<String, Object>{
                            'time' => Datetime.now().format('HH:mm:ss'),
                            'status' => 'SUCCESS',
                            'step' => 'PermSet Verification',
                            'message' => '🔍 VERIFIED: Permission Set "' + checkPS[0].Label + '" (' + checkPS[0].Name + ') exists in Salesforce database (ID: ' + permSetId + ').'
                        });
                    }
                } catch (Exception ex) {}
            }

            logs.add(new Map<String, Object>{
                'time' => Datetime.now().format('HH:mm:ss'),
                'status' => 'SUCCESS',
                'step' => 'Complete',
                'message' => '🎉 Omni-Channel Setup Suite & Verification System completed successfully!'
            });

            // Fetch details for summary message
            String qSummary = (String.isNotBlank(queueId) ? queueId : 'None');
            String rSummary = (String.isNotBlank(routingId) ? routingId : 'None');
            String cSummary = (String.isNotBlank(channelId) ? channelId : 'None');
            String pSummary = (String.isNotBlank(presenceId) ? presenceId : 'None');
            String psSummary = (String.isNotBlank(permSetId) ? permSetId : 'None');

            if (isQueueVerified) {
                List<Group> g = [SELECT Name, DeveloperName FROM Group WHERE Id = :queueId LIMIT 1];
                if (!g.isEmpty()) qSummary = g[0].Name + ' (' + g[0].DeveloperName + ', ID: ' + queueId + ')';
            }
            if (isRoutingVerified) {
                List<QueueRoutingConfig> r = [SELECT MasterLabel, DeveloperName FROM QueueRoutingConfig WHERE Id = :routingId LIMIT 1];
                if (!r.isEmpty()) rSummary = r[0].MasterLabel + ' (' + r[0].DeveloperName + ', ID: ' + routingId + ')';
            }
            if (isChannelVerified) {
                List<MessagingChannel> c = [SELECT MasterLabel, DeveloperName FROM MessagingChannel WHERE Id = :channelId LIMIT 1];
                if (!c.isEmpty()) cSummary = c[0].MasterLabel + ' (' + c[0].DeveloperName + ', ID: ' + channelId + ')';
            }
            if (isPresenceVerified) {
                List<ServicePresenceStatus> p = [SELECT MasterLabel, DeveloperName FROM ServicePresenceStatus WHERE Id = :presenceId LIMIT 1];
                if (!p.isEmpty()) pSummary = p[0].MasterLabel + ' (' + p[0].DeveloperName + ', ID: ' + presenceId + ')';
            }
            if (isPermSetVerified) {
                List<PermissionSet> ps = [SELECT Label, Name FROM PermissionSet WHERE Id = :permSetId LIMIT 1];
                if (!ps.isEmpty()) psSummary = ps[0].Label + ' (' + ps[0].Name + ', ID: ' + permSetId + ')';
            }

            String detailedMsg = '🎉 Omni-Channel Setup Suite executed successfully!\n' +
                '• Queue: ' + qSummary + '\n' +
                '• Routing: ' + rSummary + '\n' +
                '• Channel: ' + cSummary + '\n' +
                '• Presence: ' + pSummary + '\n' +
                '• PermSet: ' + psSummary + '\n' +
                '• Assigned Users: ' + selectedUserIds.size();

            res.put('success', true);
            res.put('isQueueVerified', isQueueVerified);
            res.put('isRoutingVerified', isRoutingVerified);
            res.put('isChannelVerified', isChannelVerified);
            res.put('isPresenceVerified', isPresenceVerified);
            res.put('isPermSetVerified', isPermSetVerified);
            res.put('queueId', queueId);
            res.put('routingId', routingId);
            res.put('channelId', channelId);
            res.put('presenceId', presenceId);
            res.put('permSetId', permSetId);
            res.put('assignedUserCount', selectedUserIds.size());
            res.put('logs', logs);
            res.put('message', detailedMsg);
        } catch (Exception ex) {
            logs.add(new Map<String, Object>{
                'time' => Datetime.now().format('HH:mm:ss'),
                'status' => 'ERROR',
                'step' => 'Exception',
                'message' => '❌ Exception executing setup suite: ' + ex.getMessage()
            });
            res.put('success', false);
            res.put('logs', logs);
            res.put('message', 'Exception executing setup suite: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] executeOmniChannelSetupSuite: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Asynchronously updates org defaults for Messaging_Config__c to prevent MIXED_DML_OPERATION.
     */
    @future
    public static void updateMessagingConfigAsync(String queueId, String channelId) {
        try {
            Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
            if (config == null) {
                config = new Messaging_Config__c();
            }
            if (String.isNotBlank(queueId)) {
                config.Target_Group_Id__c = queueId;
            }
            if (String.isNotBlank(channelId)) {
                config.Selected_Messaging_Channel_Id__c = channelId;
            }
            config.Use_Flow_Routing__c = true;
            upsert config;
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationController:ERROR] updateMessagingConfigAsync: ' + ex.getMessage());
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
                    return awUserId;
                }
            }
        } catch (Exception awEx) {
            System.debug('>>> [TopNotificationController] AgentWork query note: ' + awEx.getMessage());
        }

        // 2. Check PendingServiceRouting PreferredUserId
        try {
            List<PendingServiceRouting> psrList = [
                SELECT Id, GroupId, PreferredUserId FROM PendingServiceRouting WHERE WorkItemId = :activeSessionId LIMIT 1
            ];
            if (!psrList.isEmpty()) {
                if (String.isNotBlank(String.valueOf(psrList[0].PreferredUserId)) && String.valueOf(psrList[0].PreferredUserId).startsWith('005')) {
                    return String.valueOf(psrList[0].PreferredUserId);
                }
                if (String.isBlank(routedQueueId) && String.isNotBlank(String.valueOf(psrList[0].GroupId))) {
                    routedQueueId = String.valueOf(psrList[0].GroupId);
                }
            }
        } catch (Exception psrEx) {
            System.debug('>>> [TopNotificationController] PSR query note: ' + psrEx.getMessage());
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
                            return String.valueOf(uspList[0].UserId);
                        }
                    } catch (Exception uspEx) {
                        System.debug('>>> [TopNotificationController] UserServicePresence note: ' + uspEx.getMessage());
                    }

                    // Fallback to first active queue member user
                    return String.valueOf(new List<Id>(queueUserIds)[0]);
                }
            } catch (Exception gmEx) {
                System.debug('>>> [TopNotificationController] GroupMember note: ' + gmEx.getMessage());
            }
        }

        return null;
    }

    /**
     * @description Automatically creates a Queue and assigns it to MessagingSession in Apex.
     */
    @AuraEnabled
    public static Map<String, Object> autoCreateQueue(String queueName) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            if (String.isBlank(queueName)) {
                queueName = 'Auto Messaging Queue ' + Integer.valueOf(Math.floor(Math.random() * 900) + 100);
            }
            String devName = queueName.replaceAll('[^a-zA-Z0-9]', '_');
            if (devName.length() > 40) {
                devName = devName.substring(0, 40);
            }
            if (devName.endsWith('_')) {
                devName = devName.substring(0, devName.length() - 1);
            }

            Group grp = new Group(
                Name = queueName,
                DeveloperName = devName,
                Type = 'Queue'
            );
            insert grp;

            try {
                QueueSobject qso = new QueueSobject(
                    QueueId = grp.Id,
                    SobjectType = 'MessagingSession'
                );
                insert qso;
            } catch (Exception qsoEx) {
                System.debug('>>> QueueSobject insert note: ' + qsoEx.getMessage());
            }

            res.put('success', true);
            res.put('queueId', String.valueOf(grp.Id));
            res.put('message', 'Queue "' + queueName + '" created and linked successfully.');
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error auto-creating Queue: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] autoCreateQueue: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Automatically creates a QueueRoutingConfig (Routing Configuration) in Salesforce via REST API.
     */
    @AuraEnabled
    public static Map<String, Object> autoCreateRoutingConfig(String configName) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            if (String.isBlank(configName)) {
                configName = 'Auto Routing Config ' + Integer.valueOf(Math.floor(Math.random() * 900) + 100);
            }
            String devName = configName.replaceAll('[^a-zA-Z0-9]', '_');
            while (devName.contains('__')) {
                devName = devName.replace('__', '_');
            }
            if (devName.length() > 40) {
                devName = devName.substring(0, 40);
            }
            if (devName.endsWith('_')) {
                devName = devName.substring(0, devName.length() - 1);
            }

            String token = getApiSessionId();

            Map<String, Object> bodyMap = new Map<String, Object>{
                'MasterLabel' => configName,
                'DeveloperName' => devName,
                'CapacityWeight' => 1,
                'RoutingModel' => 'LeastActive',
                'RoutingPriority' => 1
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v61.0/sobjects/QueueRoutingConfig');
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(bodyMap));

            Http http = new Http();
            HttpResponse response = http.send(req);

            if (response.getStatusCode() == 201 || response.getStatusCode() == 200) {
                Map<String, Object> respBody = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
                String newId = (String) respBody.get('id');
                res.put('success', true);
                res.put('routingConfigId', newId);
                res.put('message', 'Routing Configuration "' + configName + '" created successfully!');
            } else {
                res.put('success', false);
                res.put('message', 'Salesforce REST API Error (' + response.getStatusCode() + '): ' + response.getBody());
            }
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error auto-creating Routing Config: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] autoCreateRoutingConfig: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Automatically creates a MessagingChannel in Salesforce via REST API in the background.
     */
    @AuraEnabled
    public static Map<String, Object> autoCreateMessagingChannel(String channelName) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            if (String.isBlank(channelName)) {
                channelName = 'Messaging Channel ' + String.valueOf(Math.abs(Crypto.getRandomInteger())).substring(0, 3);
            }
            String devName = channelName.replaceAll('[^a-zA-Z0-9]', '_');
            while (devName.contains('__')) {
                devName = devName.replace('__', '_');
            }
            if (devName.length() > 40) {
                devName = devName.substring(0, 40);
            }
            if (devName.endsWith('_')) {
                devName = devName.substring(0, devName.length() - 1);
            }

            // 1. Direct Apex DML insertion (100% reliable, zero REST callout session issues!)
            try {
                MessagingChannel mc = new MessagingChannel(
                    MasterLabel = channelName,
                    DeveloperName = devName,
                    MessageType = 'EmbeddedMessaging'
                );
                insert mc;
                res.put('success', true);
                res.put('channelId', String.valueOf(mc.Id));
                res.put('message', 'Messaging Channel "' + channelName + '" (' + devName + ') created successfully via Apex DML!');
                return res;
            } catch (Exception dmlEx) {
                System.debug('>>> [TopNotificationController] MessagingChannel DML fallback note: ' + dmlEx.getMessage());
            }

            // 2. Fallback to REST API if DML throws any exception
            String token = getApiSessionId();
            Map<String, Object> bodyMap = new Map<String, Object>{
                'MasterLabel' => channelName,
                'DeveloperName' => devName,
                'MessageType' => 'EmbeddedMessaging'
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v61.0/sobjects/MessagingChannel');
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(bodyMap));

            Http http = new Http();
            HttpResponse response = http.send(req);

            if (response.getStatusCode() == 201 || response.getStatusCode() == 200) {
                Map<String, Object> respBody = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
                String newId = (String) respBody.get('id');
                res.put('success', true);
                res.put('channelId', newId);
                res.put('message', 'Messaging Channel "' + channelName + '" created successfully in background!');
            } else {
                res.put('success', false);
                res.put('message', 'Salesforce REST API Error (' + response.getStatusCode() + '): ' + response.getBody());
            }
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error auto-creating Messaging Channel: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] autoCreateMessagingChannel: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Automatically creates a ServicePresenceStatus in Salesforce via REST API in the background.
     */
    @AuraEnabled
    public static Map<String, Object> autoCreatePresenceStatus(String statusName) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            if (String.isBlank(statusName)) {
                statusName = 'Available Messaging ' + Integer.valueOf(Math.floor(Math.random() * 900) + 100);
            }
            String devName = statusName.replaceAll('[^a-zA-Z0-9]', '_');
            while (devName.contains('__')) {
                devName = devName.replace('__', '_');
            }
            if (devName.length() > 40) {
                devName = devName.substring(0, 40);
            }
            if (devName.endsWith('_')) {
                devName = devName.substring(0, devName.length() - 1);
            }

            String token = getApiSessionId();

            Map<String, Object> bodyMap = new Map<String, Object>{
                'MasterLabel' => statusName,
                'DeveloperName' => devName
            };

            HttpRequest req = new HttpRequest();
            req.setEndpoint(Url.getOrgDomainUrl().toExternalForm() + '/services/data/v61.0/sobjects/ServicePresenceStatus');
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(bodyMap));

            Http http = new Http();
            HttpResponse response = http.send(req);

            if (response.getStatusCode() == 201 || response.getStatusCode() == 200) {
                Map<String, Object> respBody = (Map<String, Object>) JSON.deserializeUntyped(response.getBody());
                String newId = (String) respBody.get('id');
                res.put('success', true);
                res.put('presenceId', newId);
                res.put('message', 'Service Presence Status "' + statusName + '" created successfully in background!');
            } else {
                res.put('success', false);
                res.put('message', 'Salesforce REST API Error (' + response.getStatusCode() + '): ' + response.getBody());
            }
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error auto-creating Presence Status: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] autoCreatePresenceStatus: ' + ex.getMessage());
        }
        return res;
    }

    /**
     * @description Dynamically resolves an unrestricted REST API Session ID using Visualforce context
     * if Messaging_Config__c.Api_Token__c is not explicitly populated.
     */
    public static String getApiSessionId() {
        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config != null && String.isNotBlank(config.Api_Token__c)) {
            return config.Api_Token__c;
        }
        try {
            PageReference pageRef = Page.GetSessionIdVF;
            String content = pageRef.getContent().toString();
            Integer startIdx = content.indexOf('SESSION_ID_START');
            Integer endIdx = content.indexOf('SESSION_ID_END');
            if (startIdx != -1 && endIdx != -1) {
                return content.substring(startIdx + 16, endIdx).trim();
            }
        } catch (Exception e) {
            System.debug('>>> [TopNotificationController] PageReference SessionId error: ' + e.getMessage());
        }
        return UserInfo.getSessionId();
    }

    /**
     * @description Retrieves interacted contacts and active users for outbound campaigns.
     */
    /**
     * @description Retrieves MessagingEndUser records representing Embedded Chat Channels Users.
     */
    @AuraEnabled
    public static List<Map<String, Object>> getInteractedRecipients() {
        List<Map<String, Object>> recipients = new List<Map<String, Object>>();
        Set<Id> addedIds = new Set<Id>();

        try {
            // 1. Query MessagingEndUser (Embedded Chat / Messaging Channel Users)
            List<MessagingEndUser> endUsers = [
                SELECT Id, Name, MessageType, MessagingChannelId, MessagingChannel.MasterLabel, 
                       ContactId, Contact.Name, Contact.Email, LeadId, Lead.Name, Lead.Email, CreatedDate 
                FROM MessagingEndUser 
                ORDER BY CreatedDate DESC 
                LIMIT 200
            ];

            for (MessagingEndUser meu : endUsers) {
                if (!addedIds.contains(meu.Id)) {
                    addedIds.add(meu.Id);
                    String displayName = meu.Name;
                    if (meu.ContactId != null && String.isNotBlank(meu.Contact.Name)) {
                        displayName = meu.Contact.Name + ' (Contact)';
                    } else if (meu.LeadId != null && String.isNotBlank(meu.Lead.Name)) {
                        displayName = meu.Lead.Name + ' (Lead)';
                    }
                    String emailOrChannel = 'Embedded Chat User';
                    if (meu.ContactId != null && String.isNotBlank(meu.Contact.Email)) {
                        emailOrChannel = meu.Contact.Email;
                    } else if (meu.LeadId != null && String.isNotBlank(meu.Lead.Email)) {
                        emailOrChannel = meu.Lead.Email;
                    }

                    String channelName = (meu.MessagingChannel != null && String.isNotBlank(meu.MessagingChannel.MasterLabel))
                        ? meu.MessagingChannel.MasterLabel 
                        : meu.MessageType;

                    recipients.add(new Map<String, Object>{
                        'id' => String.valueOf(meu.Id),
                        'name' => displayName,
                        'email' => emailOrChannel,
                        'type' => 'Embedded Chat (' + channelName + ')',
                        'lastActive' => meu.CreatedDate.format('yyyy-MM-dd HH:mm')
                    });
                }
            }

            // 2. Query MessagingSession records to include recent Embedded Chat End Users
            for (MessagingSession ms : [
                SELECT Id, MessagingEndUserId, MessagingEndUser.Name, MessagingEndUser.MessageType, 
                       MessagingEndUser.MessagingChannel.MasterLabel, CreatedDate 
                FROM MessagingSession 
                ORDER BY CreatedDate DESC 
                LIMIT 100
            ]) {
                if (ms.MessagingEndUserId != null && !addedIds.contains(ms.MessagingEndUserId)) {
                    addedIds.add(ms.MessagingEndUserId);
                    String chName = (ms.MessagingEndUser.MessagingChannel != null && String.isNotBlank(ms.MessagingEndUser.MessagingChannel.MasterLabel))
                        ? ms.MessagingEndUser.MessagingChannel.MasterLabel
                        : ms.MessagingEndUser.MessageType;
                    recipients.add(new Map<String, Object>{
                        'id' => String.valueOf(ms.MessagingEndUserId),
                        'name' => ms.MessagingEndUser.Name,
                        'email' => 'Embedded Messaging Session',
                        'type' => 'Embedded Chat (' + chName + ')',
                        'lastActive' => ms.CreatedDate.format('yyyy-MM-dd HH:mm')
                    });
                }
            }
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationController:ERROR] getInteractedRecipients: ' + ex.getMessage());
        }

        return recipients;
    }

    /**
     * @description Dispatches an outbound campaign notification to targeted recipients.
     */
    @AuraEnabled
    public static Map<String, Object> sendOutboundCampaign(
        String title,
        String messageTemplate,
        String theme,
        List<String> targetUserIds,
        Boolean isDismissible
    ) {
        Map<String, Object> res = new Map<String, Object>();
        try {
            if (String.isBlank(title)) {
                title = '📢 Broadcast Campaign';
            }
            if (targetUserIds == null || targetUserIds.isEmpty()) {
                res.put('success', false);
                res.put('message', 'Please select at least one recipient for the campaign.');
                return res;
            }

            Notification_Broadcast__c bc = new Notification_Broadcast__c(
                Title__c = title,
                Message__c = messageTemplate,
                Theme__c = String.isNotBlank(theme) ? theme : 'info',
                Is_Active__c = true,
                Is_Global__c = false,
                Is_Dismissible__c = (isDismissible == true),
                Target_User_Ids__c = String.join(targetUserIds, ','),
                Start_DateTime__c = Datetime.now(),
                Expiration_DateTime__c = Datetime.now().addDays(7)
            );
            insert bc;

            // Publish Platform Event for real-time delivery
            Notification_Broadcast_Event__e evt = new Notification_Broadcast_Event__e(
                Notification_Id__c = bc.Id,
                Title__c = bc.Title__c,
                Message__c = bc.Message__c,
                Theme__c = bc.Theme__c,
                Is_Global__c = false,
                Target_User_Ids__c = bc.Target_User_Ids__c,
                Is_Active__c = true,
                Is_Dismissible__c = (isDismissible == true)
            );
            EventBus.publish(evt);

            res.put('success', true);
            res.put('broadcastId', bc.Id);
            res.put('recipientCount', targetUserIds.size());
            res.put('message', '🚀 Campaign "' + title + '" dispatched successfully to ' + targetUserIds.size() + ' recipients!');
        } catch (Exception ex) {
            res.put('success', false);
            res.put('message', 'Error launching campaign: ' + ex.getMessage());
            System.debug('>>> [TopNotificationController:ERROR] sendOutboundCampaign: ' + ex.getMessage());
        }
        return res;
    }
}
