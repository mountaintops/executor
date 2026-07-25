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
        configMap.put('isGlobal', (config != null && config.Is_Global_Default__c != null) ? config.Is_Global_Default__c : false);
        configMap.put('autoQueueDetector', (config != null && config.Auto_Queue_Detector__c != null) ? config.Auto_Queue_Detector__c : true);
        configMap.put('detectJoinedAgent', (config != null && config.Detect_Joined_Agent__c != null) ? config.Detect_Joined_Agent__c : true);
        configMap.put('targetGroupId', (config != null && String.isNotBlank(config.Target_Group_Id__c)) ? config.Target_Group_Id__c : '');
        
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
            if (payload.containsKey('isGlobal')) {
                config.Is_Global_Default__c = (Boolean) payload.get('isGlobal');
            }
            if (payload.containsKey('autoQueueDetector')) {
                config.Auto_Queue_Detector__c = (Boolean) payload.get('autoQueueDetector');
            }
            if (payload.containsKey('detectJoinedAgent')) {
                config.Detect_Joined_Agent__c = (Boolean) payload.get('detectJoinedAgent');
            }
            if (payload.containsKey('targetGroupId')) {
                config.Target_Group_Id__c = (String) payload.get('targetGroupId');
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
}

