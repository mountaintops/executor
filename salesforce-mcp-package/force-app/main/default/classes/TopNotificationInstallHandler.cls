global without sharing class TopNotificationInstallHandler implements InstallHandler {

    /**
     * @description Automated post-installation script executed natively by Salesforce
     * upon package installation without consuming API callout limits.
     */
    global void onInstall(InstallContext context) {
        try {
            System.debug('>>> [TopNotificationInstallHandler] Running post-install setup script...');

            // Seed initial welcome/system notification broadcast record if none exists
            List<Notification_Broadcast__c> existing = [
                SELECT Id 
                FROM Notification_Broadcast__c 
                LIMIT 1
            ];

            if (existing.isEmpty()) {
                Notification_Broadcast__c initialBroadcast = new Notification_Broadcast__c();
                initialBroadcast.Title__c = 'Welcome to Top Notification Bar!';
                initialBroadcast.Message__c = 'The Top Notification Bar package has been successfully installed and provisioned.';
                initialBroadcast.Theme__c = 'info';
                initialBroadcast.Is_Active__c = false; // Kept inactive until admin activates
                initialBroadcast.Is_Global__c = true;
                initialBroadcast.Is_Dismissible__c = true;
                insert initialBroadcast;

                System.debug('>>> [TopNotificationInstallHandler] Created default initial Notification_Broadcast__c record ID: ' + initialBroadcast.Id);
            }
        } catch (Exception ex) {
            System.debug('>>> [TopNotificationInstallHandler] Post-install setup note: ' + ex.getMessage());
        }
    }
}
