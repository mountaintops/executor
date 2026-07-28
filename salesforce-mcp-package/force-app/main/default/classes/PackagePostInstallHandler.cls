global class PackagePostInstallHandler implements System.InstallHandler {
    
    /**
     * @description Executed automatically by Salesforce whenever the package is deployed or installed.
     * Automatically initializes Messaging_Config__c org defaults and assigns permission sets.
     */
    global void onInstall(System.InstallContext context) {
        initializeOrgDefaults();
        assignAdminPermissionSet();
    }

    /**
     * @description Initializes Messaging_Config__c Custom Setting org defaults.
     */
    public static void initializeOrgDefaults() {
        Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
        if (config == null) {
            config = new Messaging_Config__c();
        }

        Boolean isModified = false;

        if (String.isBlank(config.Selected_Messaging_Channel_Id__c)) {
            config.Selected_Messaging_Channel_Id__c = 'ALL';
            isModified = true;
        }

        if (String.isBlank(config.Agent_Keyword__c)) {
            config.Agent_Keyword__c = 'agent';
            isModified = true;
        }

        if (String.isBlank(config.Confirmation_Text__c)) {
            config.Confirmation_Text__c = 'transmited notification';
            isModified = true;
        }

        if (String.isBlank(config.Reactivation_Keyword__c)) {
            config.Reactivation_Keyword__c = 'reset';
            isModified = true;
        }

        if (config.Auto_Queue_Detector__c == null) {
            config.Auto_Queue_Detector__c = true;
            isModified = true;
        }

        if (config.Detect_Joined_Agent__c == null) {
            config.Detect_Joined_Agent__c = true;
            isModified = true;
        }

        if (config.Use_Flow_Routing__c == null) {
            config.Use_Flow_Routing__c = true;
            isModified = true;
        }

        if (isModified || config.Id == null) {
            upsert config;
            System.debug('>>> [PackagePostInstallHandler] Successfully initialized Messaging_Config__c org defaults.');
        }
    }

    /**
     * @description Assigns Top_Notification_Admin_Access permission set to current user.
     */
    public static void assignAdminPermissionSet() {
        try {
            List<PermissionSet> psList = [
                SELECT Id 
                FROM PermissionSet 
                WHERE Name = 'Top_Notification_Admin_Access' 
                LIMIT 1
            ];
            if (!psList.isEmpty()) {
                Id currentUserId = UserInfo.getUserId();
                List<PermissionSetAssignment> existing = [
                    SELECT Id 
                    FROM PermissionSetAssignment 
                    WHERE AssigneeId = :currentUserId AND PermissionSetId = :psList[0].Id 
                    LIMIT 1
                ];
                if (existing.isEmpty()) {
                    PermissionSetAssignment psa = new PermissionSetAssignment(
                        AssigneeId = currentUserId,
                        PermissionSetId = psList[0].Id
                    );
                    insert psa;
                    System.debug('>>> [PackagePostInstallHandler] Assigned Top_Notification_Admin_Access to user: ' + currentUserId);
                }
            }
        } catch (Exception ex) {
            System.debug('>>> [PackagePostInstallHandler] PermissionSet assignment note: ' + ex.getMessage());
        }
    }
}
