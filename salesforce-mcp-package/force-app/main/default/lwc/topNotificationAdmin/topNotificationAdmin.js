import { LightningElement, track } from 'lwc';
import getAgentNotificationConfig from '@salesforce/apex/TopNotificationController.getAgentNotificationConfig';
import saveAgentNotificationConfig from '@salesforce/apex/TopNotificationController.saveAgentNotificationConfig';
import getAdminOptions from '@salesforce/apex/TopNotificationController.getAdminOptions';
import getAllBroadcasts from '@salesforce/apex/TopNotificationController.getAllBroadcasts';
import saveAndActivateNotification from '@salesforce/apex/TopNotificationController.saveAndActivateNotification';
import deactivateNotification from '@salesforce/apex/TopNotificationController.deactivateNotification';

const TABLE_COLUMNS = [
    { label: 'Broadcast Name', fieldName: 'name', type: 'text', width: 120 },
    { label: 'Title', fieldName: 'title', type: 'text' },
    { label: 'Message', fieldName: 'message', type: 'text' },
    { label: 'Active', fieldName: 'isActive', type: 'boolean', width: 90 },
    { label: 'Global', fieldName: 'isGlobal', type: 'boolean', width: 90 },
    {
        type: 'action',
        typeAttributes: {
            rowActions: [
                { label: 'Deactivate', name: 'deactivate' }
            ]
        }
    }
];

export default class TopNotificationAdmin extends LightningElement {
    @track agentKeyword = 'agent';
    @track isGlobal = false; // Disabled by default
    @track autoQueueDetector = true;
    @track detectJoinedAgent = true;
    @track targetGroupId = '';

    @track statusAlertMessage = '';
    @track groupOptions = [];
    @track broadcastTableData = [];

    columns = TABLE_COLUMNS;

    connectedCallback() {
        this.loadAdminConfig();
        this.loadAdminOptions();
        this.loadBroadcastHistory();
    }

    async loadAdminConfig() {
        try {
            const config = await getAgentNotificationConfig();
            if (config) {
                this.agentKeyword = config.agentKeyword || 'agent';
                this.isGlobal = config.isGlobal === true;
                this.autoQueueDetector = config.autoQueueDetector !== false;
                this.detectJoinedAgent = config.detectJoinedAgent !== false;
                this.targetGroupId = config.targetGroupId || '';
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading agent config:', err);
        }
    }

    async loadAdminOptions() {
        try {
            const opts = await getAdminOptions();
            if (opts && opts.groups) {
                this.groupOptions = opts.groups.map(g => ({
                    label: `${g.Name} (${g.Type})`,
                    value: g.Id
                }));
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading admin options:', err);
        }
    }

    async loadBroadcastHistory() {
        try {
            const list = await getAllBroadcasts();
            if (list) {
                this.broadcastTableData = list.map(b => ({
                    id: b.Id,
                    name: b.Name,
                    title: b.Title__c,
                    message: b.Message__c,
                    isActive: b.Is_Active__c,
                    isGlobal: b.Is_Global__c
                }));
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading broadcasts:', err);
        }
    }

    handleKeywordChange(event) {
        this.agentKeyword = event.target.value;
    }

    handleGlobalToggle(event) {
        this.isGlobal = event.target.checked;
    }

    handleAutoQueueToggle(event) {
        this.autoQueueDetector = event.target.checked;
    }

    handleDetectJoinedAgentToggle(event) {
        this.detectJoinedAgent = event.target.checked;
    }

    handleTargetGroupChange(event) {
        this.targetGroupId = event.detail.value;
    }

    async handleSaveConfig() {
        this.statusAlertMessage = '';
        try {
            const payload = {
                agentKeyword: this.agentKeyword,
                isGlobal: this.isGlobal,
                autoQueueDetector: this.autoQueueDetector,
                detectJoinedAgent: this.detectJoinedAgent,
                targetGroupId: this.targetGroupId
            };
            const res = await saveAgentNotificationConfig({ payload: payload });
            if (res && res.success) {
                this.showStatusAlert('✅ Settings saved successfully. Keyword "' + this.agentKeyword + '" will trigger Top Notification Bar.');
            } else {
                this.showStatusAlert('❌ Error saving settings: ' + (res ? res.message : 'Unknown error'));
            }
        } catch (err) {
            this.showStatusAlert('❌ Exception saving settings: ' + (err.body ? err.body.message : err.message));
        }
    }

    async handleTestBroadcast() {
        this.statusAlertMessage = '';
        try {
            const payload = {
                title: '📢 Customer Requested Agent (Simulated)',
                message: `Simulated inbound customer message matching keyword "${this.agentKeyword}".`,
                theme: 'warning',
                isGlobal: this.isGlobal,
                isDismissible: true,
                deactivateOthers: true
            };
            const res = await saveAndActivateNotification({ payload: payload });
            if (res && res.success) {
                this.showStatusAlert('🚀 Test Top Notification Bar broadcast activated successfully!');
                await this.loadBroadcastHistory();
            } else {
                this.showStatusAlert('❌ Error activating test broadcast: ' + (res ? res.message : 'Unknown error'));
            }
        } catch (err) {
            this.showStatusAlert('❌ Exception activating test broadcast: ' + (err.body ? err.body.message : err.message));
        }
    }

    async handleRowAction(event) {
        const actionName = event.detail.action.name;
        const row = event.detail.row;

        if (actionName === 'deactivate') {
            try {
                const res = await deactivateNotification({ recordId: row.id });
                if (res && res.success) {
                    this.showStatusAlert(`Notification banner ${row.name} deactivated.`);
                    await this.loadBroadcastHistory();
                }
            } catch (err) {
                console.error('[TopNotificationAdmin] Error deactivating record:', err);
            }
        }
    }

    showStatusAlert(msg) {
        this.statusAlertMessage = msg;
        setTimeout(() => {
            if (this.statusAlertMessage === msg) {
                this.statusAlertMessage = '';
            }
        }, 6000);
    }
}
