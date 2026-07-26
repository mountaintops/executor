import { LightningElement, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getAgentNotificationConfig from '@salesforce/apex/TopNotificationController.getAgentNotificationConfig';
import saveAgentNotificationConfig from '@salesforce/apex/TopNotificationController.saveAgentNotificationConfig';
import getAdminOptions from '@salesforce/apex/TopNotificationController.getAdminOptions';
import getSimulatedAgentTargetingDetails from '@salesforce/apex/TopNotificationController.getSimulatedAgentTargetingDetails';
import getRealSystemDetections from '@salesforce/apex/TopNotificationController.getRealSystemDetections';
import autoCreateQueue from '@salesforce/apex/TopNotificationController.autoCreateQueue';
import autoCreateRoutingConfig from '@salesforce/apex/TopNotificationController.autoCreateRoutingConfig';
import autoCreateMessagingChannel from '@salesforce/apex/TopNotificationController.autoCreateMessagingChannel';
import autoCreatePresenceStatus from '@salesforce/apex/TopNotificationController.autoCreatePresenceStatus';
import checkAndSendInactivityReminders from '@salesforce/apex/TopNotificationController.checkAndSendInactivityReminders';
import executeOmniChannelSetupSuite from '@salesforce/apex/TopNotificationController.executeOmniChannelSetupSuite';
import getInteractedRecipients from '@salesforce/apex/TopNotificationController.getInteractedRecipients';
import sendOutboundCampaign from '@salesforce/apex/TopNotificationController.sendOutboundCampaign';

export default class TopNotificationAdmin extends NavigationMixin(LightningElement) {
    @track agentKeyword = 'agent';
    @track confirmationText = 'transmited notification';
    @track reactivationKeyword = 'reset';

    // Outbound Campaign State
    @track campaignRecipients = [];
    @track selectedCampaignRecipientIds = [];
    @track campaignSearchTerm = '';
    @track campaignTitle = '📢 Special Announcement';
    @track campaignMessage = 'Dear {Name},\n\nWe have an important update regarding your account. Please feel free to reach out to our team anytime!\n\nBest regards,\nSupport Team';
    @track campaignTheme = 'info';
    @track campaignIsDismissible = true;
    @track isSendingCampaign = false;
    @track selectedTemplate = 'CUSTOM';
    @track isLoadingCampaignRecipients = false;

    @track reminderEnabled = false;
    @track reminderMinutes = 5;
    @track reminderTemplate = 'Hello {customer_name}, we noticed you have been waiting for {minutes_passed} minutes. An agent will be with you shortly!';

    // Setup Wizard State
    @track isSetupWizardOpen = false;
    @track setupMode = 'MISSING';
    @track setupMethod = 'AUTO';
    @track selectedUserIds = [];
    @track userOptions = [];
    @track isExecutingSetup = false;

    @track isGlobal = false;
    @track autoQueueDetector = true;
    @track detectJoinedAgent = true;
    @track useFlowRouting = true;
    @track selectedMessagingChannelId = 'ALL';
    @track disabledChannelIds = '';
    @track targetGroupId = '';

    @track statusAlertMessage = '';
    @track groupOptions = [];
    @track channelOptions = [
        { label: '🌐 Follow All Deployments (Automatic System Detection)', value: 'ALL' }
    ];
    @track simulationResult = null;
    @track systemDetections = null;

    // Inspection Popup Modal State
    @track isInspectModalOpen = false;
    @track selectedChannel = null;
    @track customSelectedQueueId = null;
    @track customSelectedRoutingId = null;
    @track customSelectedDeploymentValue = null;
    @track customSelectedPresenceId = null;

    get availableTemplateVariables() {
        return [
            { label: '{customer_name}', tag: '{customer_name}' },
            { label: '{minutes_passed}', tag: '{minutes_passed}' },
            { label: '{agent_keyword}', tag: '{agent_keyword}' },
            { label: '{reactivation_keyword}', tag: '{reactivation_keyword}' },
            { label: '{channel_name}', tag: '{channel_name}' },
            { label: '{session_id}', tag: '{session_id}' }
        ];
    }

    handleInsertVariableTag(event) {
        const tag = event.target.dataset.tag;
        if (tag) {
            this.reminderTemplate = (this.reminderTemplate ? this.reminderTemplate.trim() : '') + ' ' + tag;
        }
    }

    connectedCallback() {
        this.loadAdminConfig();
        this.loadAdminOptions();
        this.loadRealSystemDetections();
        this.loadCampaignRecipients();
    }

    async loadCampaignRecipients() {
        this.isLoadingCampaignRecipients = true;
        try {
            const res = await getInteractedRecipients();
            if (res) {
                this.campaignRecipients = res.map(r => ({
                    ...r,
                    selected: true
                }));
                this.selectedCampaignRecipientIds = this.campaignRecipients.map(r => r.id);
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading campaign recipients:', err);
        } finally {
            this.isLoadingCampaignRecipients = false;
        }
    }

    get filteredCampaignRecipients() {
        if (!this.campaignSearchTerm) {
            return this.campaignRecipients;
        }
        const term = this.campaignSearchTerm.toLowerCase();
        return this.campaignRecipients.filter(r => 
            (r.name && r.name.toLowerCase().includes(term)) ||
            (r.email && r.email.toLowerCase().includes(term)) ||
            (r.type && r.type.toLowerCase().includes(term))
        );
    }

    get isAllCampaignRecipientsSelected() {
        return this.filteredCampaignRecipients.length > 0 && 
               this.filteredCampaignRecipients.every(r => this.selectedCampaignRecipientIds.includes(r.id));
    }

    get selectedRecipientCount() {
        return this.selectedCampaignRecipientIds.length;
    }

    get templateOptions() {
        return [
            { label: '✏️ Custom Message', value: 'CUSTOM' },
            { label: '📢 Scheduled System Maintenance', value: 'SYSTEM_MAINTENANCE' },
            { label: '🎉 New Feature Update Notice', value: 'PRODUCT_UPDATE' },
            { label: '⚠️ Urgent Account Action Required', value: 'URGENT_ALERT' },
            { label: '💡 Customer Support Check-in', value: 'CUSTOMER_CHECKIN' }
        ];
    }

    get campaignThemeOptions() {
        return [
            { label: 'ℹ️ Info (Blue)', value: 'info' },
            { label: '⚠️ Warning (Yellow)', value: 'warning' },
            { label: '✅ Success (Green)', value: 'success' },
            { label: '🚨 Danger / Alert (Red)', value: 'danger' }
        ];
    }

    handleCampaignSearchChange(event) {
        this.campaignSearchTerm = event.target.value;
    }

    handleToggleSelectAllRecipients(event) {
        const isChecked = event.target.checked;
        if (isChecked) {
            this.selectedCampaignRecipientIds = Array.from(new Set([
                ...this.selectedCampaignRecipientIds,
                ...this.filteredCampaignRecipients.map(r => r.id)
            ]));
        } else {
            const filteredIds = this.filteredCampaignRecipients.map(r => r.id);
            this.selectedCampaignRecipientIds = this.selectedCampaignRecipientIds.filter(id => !filteredIds.includes(id));
        }
        this.campaignRecipients = this.campaignRecipients.map(r => ({
            ...r,
            selected: this.selectedCampaignRecipientIds.includes(r.id)
        }));
    }

    handleToggleRecipient(event) {
        const recId = event.target.dataset.id;
        const isChecked = event.target.checked;
        if (isChecked) {
            if (!this.selectedCampaignRecipientIds.includes(recId)) {
                this.selectedCampaignRecipientIds = [...this.selectedCampaignRecipientIds, recId];
            }
        } else {
            this.selectedCampaignRecipientIds = this.selectedCampaignRecipientIds.filter(id => id !== recId);
        }
        this.campaignRecipients = this.campaignRecipients.map(r => ({
            ...r,
            selected: this.selectedCampaignRecipientIds.includes(r.id)
        }));
    }

    handleTemplateSelect(event) {
        const val = event.detail.value;
        this.selectedTemplate = val;
        const nowStr = new Date().toLocaleString();

        if (val === 'SYSTEM_MAINTENANCE') {
            this.campaignTitle = '📢 Scheduled System Maintenance';
            this.campaignMessage = 'Dear {Name},\n\nPlease be advised that system maintenance is scheduled for tonight. Top Notification services will remain fully active.\n\nThank you for your cooperation!';
            this.campaignTheme = 'warning';
        } else if (val === 'PRODUCT_UPDATE') {
            this.campaignTitle = '🎉 New Feature Update Notice';
            this.campaignMessage = 'Hi {Name},\n\nWe are excited to announce new feature updates available in your workspace today! Check out your control panel for details.\n\nEnjoy the new updates!';
            this.campaignTheme = 'success';
        } else if (val === 'URGENT_ALERT') {
            this.campaignTitle = '⚠️ Urgent Account Action Required';
            this.campaignMessage = 'Attention {Name},\n\nPlease check your recent notifications or contact our support team regarding pending updates on your account.';
            this.campaignTheme = 'danger';
        } else if (val === 'CUSTOMER_CHECKIN') {
            this.campaignTitle = '💡 Customer Support Check-in';
            this.campaignMessage = 'Hello {Name},\n\nOur customer support team is checking in! Let us know if you have any questions or need assistance.\n\nHave a great day!';
            this.campaignTheme = 'info';
        }
    }

    handleCampaignTitleChange(event) {
        this.campaignTitle = event.target.value;
    }

    handleCampaignMessageChange(event) {
        this.campaignMessage = event.target.value;
    }

    handleCampaignThemeChange(event) {
        this.campaignTheme = event.detail.value;
    }

    handleCampaignDismissibleChange(event) {
        this.campaignIsDismissible = event.target.checked;
    }

    insertCampaignVariable(event) {
        const varTag = event.target.dataset.tag;
        if (varTag) {
            this.campaignMessage = (this.campaignMessage ? this.campaignMessage : '') + ' ' + varTag;
        }
    }

    async handleLaunchCampaign() {
        if (!this.selectedCampaignRecipientIds || this.selectedCampaignRecipientIds.length === 0) {
            this.showStatusAlert('❌ Please select at least one recipient for the campaign.');
            return;
        }
        if (!this.campaignMessage || !this.campaignMessage.trim()) {
            this.showStatusAlert('❌ Please type a message or select a template for the campaign.');
            return;
        }

        this.isSendingCampaign = true;
        try {
            const res = await sendOutboundCampaign({
                title: this.campaignTitle,
                messageTemplate: this.campaignMessage,
                theme: this.campaignTheme,
                targetUserIds: this.selectedCampaignRecipientIds,
                isDismissible: this.campaignIsDismissible
            });

            if (res && res.success) {
                this.showStatusAlert('🎉 ' + res.message);
            } else {
                this.showStatusAlert('❌ Error launching campaign: ' + (res ? res.message : 'Unknown error'));
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] sendOutboundCampaign exception:', err);
            this.showStatusAlert('❌ Exception launching campaign: ' + (err.body ? err.body.message : err.message));
        } finally {
            this.isSendingCampaign = false;
        }
    }

    async loadRealSystemDetections() {
        try {
            const res = await getRealSystemDetections();
            if (res && res.success) {
                this.systemDetections = res;
                if (res.activeUsers) {
                    this.userOptions = res.activeUsers.map(u => ({
                        label: u.label,
                        value: u.value
                    }));
                }
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading real system info:', err);
        }
    }

    async loadAdminConfig() {
        try {
            const config = await getAgentNotificationConfig();
            if (config) {
                this.agentKeyword = config.agentKeyword || 'agent';
                this.confirmationText = config.confirmationText || 'transmited notification';
                this.reactivationKeyword = config.reactivationKeyword || 'reset';
                this.reminderEnabled = config.reminderEnabled === true;
                this.reminderMinutes = config.reminderMinutes || 5;
                this.reminderTemplate = config.reminderTemplate || 'Hello {customer_name}, we noticed you have been waiting for {minutes_passed} minutes. An agent will be with you shortly!';

                this.isGlobal = config.isGlobal === true;
                this.autoQueueDetector = config.autoQueueDetector !== false;
                this.detectJoinedAgent = config.detectJoinedAgent !== false;
                this.useFlowRouting = config.useFlowRouting !== false;
                this.selectedMessagingChannelId = config.selectedMessagingChannelId || 'ALL';
                this.targetGroupId = config.targetGroupId || '';
                this.disabledChannelIds = config.disabledChannelIds || '';
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading agent config:', err);
        }
    }

    async loadAdminOptions() {
        try {
            const opts = await getAdminOptions();
            if (opts) {
                if (opts.groups) {
                    this.groupOptions = opts.groups.map(g => ({
                        label: `${g.Name} (${g.Type})`,
                        value: g.Id
                    }));
                }
                if (opts.messagingChannels && opts.messagingChannels.length > 0) {
                    this.channelOptions = opts.messagingChannels.map(c => ({
                        label: c.label,
                        value: c.value
                    }));
                }
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error loading admin options:', err);
        }
    }

    // Setup Wizard Getters & Methods
    get isAutoSetupMethod() {
        return this.setupMethod === 'AUTO';
    }

    get isManualSetupMethod() {
        return this.setupMethod === 'MANUAL';
    }

    get setupModeOptions() {
        return [
            { label: '⚡ Create Missing Setup Only (Recommended)', value: 'MISSING' },
            { label: '✨ Create Fresh New Suite (Queue, Routing, Channel, Presence)', value: 'ALL_NEW' }
        ];
    }

    get setupMethodOptions() {
        return [
            { label: '⚡ Automatically (Recommended — No manual steps needed)', value: 'AUTO' },
            { label: '🛠️ Manually (Open Setup Pages in New Tabs)', value: 'MANUAL' }
        ];
    }

    openSetupWizard() {
        this.isSetupWizardOpen = true;
        this.executionLogs = [];
    }

    closeSetupWizard() {
        this.isSetupWizardOpen = false;
    }

    handleSetupModeChange(event) {
        this.setupMode = event.detail.value;
    }

    handleSetupMethodChange(event) {
        this.setupMethod = event.detail.value;
    }

    @track createNewChannel = true;
    @track useGlobalPresence = true;

    get hasExecutionLogs() {
        return this.executionLogs && this.executionLogs.length > 0;
    }

    openSetupWizard() {
        this.isSetupWizardOpen = true;
        this.executionLogs = [];
    }

    closeSetupWizard() {
        this.isSetupWizardOpen = false;
    }

    handleSetupModeChange(event) {
        this.setupMode = event.detail.value;
    }

    handleSetupMethodChange(event) {
        this.setupMethod = event.detail.value;
    }

    handleCreateNewChannelChange(event) {
        this.createNewChannel = event.target.checked;
    }

    handleUseGlobalPresenceChange(event) {
        this.useGlobalPresence = event.target.checked;
    }

    handleUserSelectionChange(event) {
        this.selectedUserIds = event.detail.value;
    }

    async handleExecuteSetupSuite() {
        this.isExecutingSetup = true;
        this.statusAlertMessage = '';
        this.executionLogs = [];
        try {
            const res = await executeOmniChannelSetupSuite({
                mode: this.setupMode,
                selectedUserIds: this.selectedUserIds,
                createNewChannel: this.createNewChannel,
                useGlobalPresence: this.useGlobalPresence
            });
            if (res && res.logs) {
                this.executionLogs = res.logs;
            }
            if (res && res.success) {
                this.closeSetupWizard();
                await this.loadRealSystemDetections();
                this.showStatusAlert('🎉 ' + res.message);
            } else {
                this.showStatusAlert('❌ Error executing setup suite: ' + (res ? res.message : 'Unknown error'));
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] executeOmniChannelSetupSuite exception:', err);
            this.showStatusAlert('❌ Exception executing setup suite: ' + (err.body ? err.body.message : err.message));
        } finally {
            this.isExecutingSetup = false;
        }
    }

    // Manual Setup Links
    openQueueSetup() {
        this.openSetupUrl('/lightning/setup/Queues/home');
    }

    openRoutingSetup() {
        this.openSetupUrl('/lightning/setup/RoutingConfigurations/home');
    }

    openChannelSetup() {
        this.openSetupUrl('/lightning/setup/MessagingChannels/home');
    }

    openPresenceSetup() {
        this.openSetupUrl('/lightning/setup/ServicePresenceStatus/home');
    }

    openPermSetSetup() {
        this.openSetupUrl('/lightning/setup/PermSets/home');
    }

    // Modal Combobox Selected Values
    get selectedQueueValue() {
        if (this.customSelectedQueueId) return this.customSelectedQueueId;
        if (this.selectedChannel && this.selectedChannel.queueInfo && this.selectedChannel.queueInfo.id) {
            return this.selectedChannel.queueInfo.id;
        }
        return 'NONE';
    }

    get selectedRoutingValue() {
        if (this.customSelectedRoutingId) return this.customSelectedRoutingId;
        if (this.selectedChannel && this.selectedChannel.routingInfo && this.selectedChannel.routingInfo.id) {
            return this.selectedChannel.routingInfo.id;
        }
        return 'NONE';
    }

    get selectedDeploymentValue() {
        if (this.customSelectedDeploymentValue) return this.customSelectedDeploymentValue;
        if (this.selectedChannel && this.selectedChannel.deploymentInfo && this.selectedChannel.deploymentInfo.id) {
            return this.selectedChannel.deploymentInfo.id;
        }
        return 'ACTIVE';
    }

    get selectedPresenceValue() {
        if (this.customSelectedPresenceId) return this.customSelectedPresenceId;
        if (this.selectedChannel && this.selectedChannel.presenceInfo && this.selectedChannel.presenceInfo.id) {
            return this.selectedChannel.presenceInfo.id;
        }
        return 'NONE';
    }

    // Modal Dynamic Options Getters (Clean list with real developerNames and IDs)
    get queueOptions() {
        const opts = [];
        if (this.selectedChannel && this.selectedChannel.queueInfo && this.selectedChannel.queueInfo.id) {
            opts.push({
                label: `✅ Linked: ${this.selectedChannel.queueInfo.name} (${this.selectedChannel.queueInfo.developerName || this.selectedChannel.queueInfo.id})`,
                value: this.selectedChannel.queueInfo.id
            });
        }
        if (this.systemDetections && this.systemDetections.queues) {
            this.systemDetections.queues.forEach(q => {
                if (!opts.some(o => o.value === q.id)) {
                    opts.push({ label: `🔀 Queue: ${q.name} (${q.developerName || q.id})`, value: q.id });
                }
            });
        }
        opts.push({ label: '🌐 Broadcast to ALL (Global Fallback)', value: 'GLOBAL' });
        return opts;
    }

    get routingConfigOptions() {
        const opts = [];
        if (this.selectedChannel && this.selectedChannel.routingInfo && this.selectedChannel.routingInfo.id) {
            opts.push({
                label: `✅ Linked: ${this.selectedChannel.routingInfo.name} (${this.selectedChannel.routingInfo.developerName || this.selectedChannel.routingInfo.id})`,
                value: this.selectedChannel.routingInfo.id
            });
        }
        if (this.systemDetections && this.systemDetections.routingConfigs) {
            this.systemDetections.routingConfigs.forEach(rc => {
                if (!opts.some(o => o.value === rc.id)) {
                    opts.push({ label: `⚡ Routing Config: ${rc.name} (${rc.developerName || rc.id})`, value: rc.id });
                }
            });
        }
        opts.push({ label: '🌐 Broadcast to ALL (Global Fallback)', value: 'GLOBAL' });
        return opts;
    }

    get deploymentOptions() {
        const opts = [];
        if (this.systemDetections && this.systemDetections.channels) {
            this.systemDetections.channels.forEach(ch => {
                const isCurrent = this.selectedChannel && this.selectedChannel.id === ch.id;
                opts.push({
                    label: `${isCurrent ? '✅ Active Channel' : '📢 Channel'}: ${ch.label} (${ch.developerName || ch.id})`,
                    value: ch.id
                });
            });
        }
        opts.push({ label: '🚫 Disable System for Channel (Ignore)', value: 'IGNORE' });
        return opts;
    }

    get presenceOptions() {
        const opts = [];
        if (this.selectedChannel && this.selectedChannel.presenceInfo && this.selectedChannel.presenceInfo.id) {
            opts.push({
                label: `✅ Linked: ${this.selectedChannel.presenceInfo.name} (${this.selectedChannel.presenceInfo.developerName || this.selectedChannel.presenceInfo.id})`,
                value: this.selectedChannel.presenceInfo.id
            });
        }
        if (this.systemDetections && this.systemDetections.presenceStatuses) {
            this.systemDetections.presenceStatuses.forEach(p => {
                if (!opts.some(o => o.value === p.id)) {
                    opts.push({ label: `🟢 Presence Status: ${p.name} (${p.developerName || p.id})`, value: p.id });
                }
            });
        }
        opts.push({ label: '🌐 Broadcast to ALL (Global Fallback)', value: 'GLOBAL' });
        return opts;
    }

    // Modal Open/Close Actions
    openInspectModal(event) {
        const channelId = event.target.dataset.id;
        if (this.systemDetections && this.systemDetections.channels) {
            const match = this.systemDetections.channels.find(c => c.id === channelId);
            if (match) {
                this.selectedChannel = match;
                this.customSelectedQueueId = null;
                this.customSelectedRoutingId = null;
                this.customSelectedDeploymentValue = null;
                this.customSelectedPresenceId = null;
                this.isInspectModalOpen = true;
            }
        }
    }

    closeInspectModal() {
        this.isInspectModalOpen = false;
        this.selectedChannel = null;
    }

    // Safe Navigation helper opening in new browser tab
    openSetupUrl(url) {
        if (!url) return;
        try {
            window.open(url, '_blank');
        } catch (e) {
            console.error('[TopNotificationAdmin] window.open error:', e);
            try {
                this[NavigationMixin.Navigate]({
                    type: 'standard__webPage',
                    attributes: {
                        url: url
                    }
                });
            } catch (err) {}
        }
    }

    // Combobox Selection Handlers
    async handleQueueComboboxChange(event) {
        const val = event.detail.value;
        if (val === 'CREATE_MANUAL') {
            const homeUrl = (this.selectedChannel && this.selectedChannel.queueInfo) ? this.selectedChannel.queueInfo.homeUrl : '/lightning/setup/Queues/home';
            this.openSetupUrl(homeUrl);
            this.showStatusAlert('↗️ Navigated to Salesforce Queue Setup.');
            return;
        }
        if (val === 'CREATE_AUTO') {
            try {
                const qName = 'Auto Queue ' + (this.selectedChannel ? this.selectedChannel.label : 'Messaging');
                const res = await autoCreateQueue({ queueName: qName });
                if (res && res.success) {
                    this.customSelectedQueueId = res.queueId;
                    this.targetGroupId = res.queueId;
                    await this.handleSaveConfig();
                    await this.loadRealSystemDetections();
                    this.showStatusAlert('⚡ Automatically created new Queue "' + qName + '" in Salesforce via Apex!');
                } else {
                    this.showStatusAlert('❌ Error auto-creating Queue: ' + (res ? res.message : 'Unknown error'));
                }
            } catch (e) {
                console.error('[TopNotificationAdmin] autoCreateQueue exception:', e);
                this.showStatusAlert('❌ Exception creating queue: ' + (e.body ? e.body.message : e.message));
            }
            return;
        }
        if (val === 'GLOBAL') {
            this.isGlobal = true;
            await this.handleSaveConfig();
            this.showStatusAlert('🌐 Set Global Broadcast fallback mode.');
            return;
        }

        // Linked existing queue selected
        this.customSelectedQueueId = val;
        this.targetGroupId = val;
        await this.handleSaveConfig();
        this.showStatusAlert('✅ Linked Queue (ID: ' + val + ') to configuration.');
    }

    async handleRoutingComboboxChange(event) {
        const val = event.detail.value;
        if (val === 'CREATE_MANUAL') {
            const homeUrl = (this.selectedChannel && this.selectedChannel.routingInfo) ? this.selectedChannel.routingInfo.homeUrl : '/lightning/setup/RoutingConfigurations/home';
            this.openSetupUrl(homeUrl);
            this.showStatusAlert('↗️ Navigated to Salesforce Routing Configurations Setup.');
            return;
        }
        if (val === 'CREATE_AUTO') {
            try {
                const rName = 'Auto Routing Config ' + (this.selectedChannel ? this.selectedChannel.label : 'Messaging');
                const res = await autoCreateRoutingConfig({ configName: rName });
                if (res && res.success) {
                    this.customSelectedRoutingId = res.routingConfigId;
                    this.useFlowRouting = true;
                    await this.handleSaveConfig();
                    await this.loadRealSystemDetections();
                    this.showStatusAlert('⚡ Automatically created new Routing Configuration "' + rName + '" in Salesforce!');
                } else {
                    this.showStatusAlert('❌ Error auto-creating Routing Config: ' + (res ? res.message : 'Unknown error'));
                }
            } catch (e) {
                console.error('[TopNotificationAdmin] autoCreateRoutingConfig exception:', e);
                this.showStatusAlert('❌ Exception creating routing config: ' + (e.body ? e.body.message : e.message));
            }
            return;
        }
        if (val === 'GLOBAL') {
            this.isGlobal = true;
            await this.handleSaveConfig();
            this.showStatusAlert('🌐 Configured Global Broadcast fallback mode for routing.');
            return;
        }

        this.customSelectedRoutingId = val;
        this.useFlowRouting = true;
        await this.handleSaveConfig();
        this.showStatusAlert('✅ Selected Routing Configuration (ID: ' + val + ').');
    }

    async handleDeploymentComboboxChange(event) {
        const val = event.detail.value;
        if (val === 'CREATE_MANUAL') {
            const homeUrl = (this.selectedChannel && this.selectedChannel.deploymentInfo) ? this.selectedChannel.deploymentInfo.homeUrl : '/lightning/setup/MessagingChannels/home';
            this.openSetupUrl(homeUrl);
            this.showStatusAlert('↗️ Navigated to Salesforce Messaging Channels Setup.');
            return;
        }
        if (val === 'CREATE_AUTO') {
            try {
                const cName = 'Auto Messaging Channel ' + (this.selectedChannel ? this.selectedChannel.label : 'Messaging');
                const res = await autoCreateMessagingChannel({ channelName: cName });
                if (res && res.success) {
                    this.customSelectedDeploymentValue = res.channelId;
                    this.selectedMessagingChannelId = res.channelId;
                    await this.handleSaveConfig();
                    await this.loadRealSystemDetections();
                    this.showStatusAlert('⚡ Automatically created new Messaging Channel "' + cName + '" in Salesforce background!');
                } else {
                    this.showStatusAlert('❌ Error auto-creating Messaging Channel: ' + (res ? res.message : 'Unknown error'));
                }
            } catch (e) {
                console.error('[TopNotificationAdmin] autoCreateMessagingChannel exception:', e);
                this.showStatusAlert('❌ Exception creating messaging channel: ' + (e.body ? e.body.message : e.message));
            }
            return;
        }
        if (val === 'IGNORE') {
            if (this.selectedChannel) {
                const eventMock = { target: { dataset: { id: this.selectedChannel.id }, checked: true } };
                await this.handleToggleChannelDisabled(eventMock);
            }
            return;
        }
        this.customSelectedDeploymentValue = val;
    }

    async handlePresenceComboboxChange(event) {
        const val = event.detail.value;
        if (val === 'CREATE_MANUAL') {
            const homeUrl = (this.selectedChannel && this.selectedChannel.presenceInfo) ? this.selectedChannel.presenceInfo.homeUrl : '/lightning/setup/ServicePresenceStatus/home';
            this.openSetupUrl(homeUrl);
            this.showStatusAlert('↗️ Navigated to Salesforce Service Presence Status Setup.');
            return;
        }
        if (val === 'CREATE_AUTO') {
            try {
                const pName = 'Available Messaging ' + (this.selectedChannel ? this.selectedChannel.label : 'Status');
                const res = await autoCreatePresenceStatus({ statusName: pName });
                if (res && res.success) {
                    this.customSelectedPresenceId = res.presenceId;
                    await this.handleSaveConfig();
                    await this.loadRealSystemDetections();
                    this.showStatusAlert('⚡ Automatically created new Service Presence Status "' + pName + '" in Salesforce background!');
                } else {
                    this.showStatusAlert('❌ Error auto-creating Presence Status: ' + (res ? res.message : 'Unknown error'));
                }
            } catch (e) {
                console.error('[TopNotificationAdmin] autoCreatePresenceStatus exception:', e);
                this.showStatusAlert('❌ Exception creating presence status: ' + (e.body ? e.body.message : e.message));
            }
            return;
        }
        if (val === 'GLOBAL') {
            this.isGlobal = true;
            await this.handleSaveConfig();
            this.showStatusAlert('🌐 Configured Global Presence Fallback.');
            return;
        }

        this.customSelectedPresenceId = val;
        this.showStatusAlert('✅ Selected Presence Status (ID: ' + val + ').');
    }

    handleKeywordChange(event) {
        this.agentKeyword = event.target.value;
    }

    handleConfirmationTextChange(event) {
        this.confirmationText = event.target.value;
    }

    handleReactivationKeywordChange(event) {
        this.reactivationKeyword = event.target.value;
    }

    handleReminderEnabledChange(event) {
        this.reminderEnabled = event.target.checked;
    }

    handleReminderMinutesChange(event) {
        this.reminderMinutes = event.target.value;
    }

    handleReminderTemplateChange(event) {
        this.reminderTemplate = event.target.value;
    }

    async handleRunInactivityCheck() {
        this.statusAlertMessage = '';
        try {
            const res = await checkAndSendInactivityReminders();
            if (res && res.success) {
                this.showStatusAlert(`⏱️ Inactivity check complete: ${res.message}`);
            } else {
                this.showStatusAlert(`⚠️ Inactivity check result: ${res ? res.message : 'Unknown result'}`);
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Exception running inactivity check:', err);
            this.showStatusAlert('❌ Exception running inactivity check: ' + (err.body ? err.body.message : err.message));
        }
    }

    async handleToggleChannelDisabled(event) {
        const channelId = event.target.dataset.id;
        const isChecked = event.target.checked;

        let disabledArray = this.disabledChannelIds ? this.disabledChannelIds.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (isChecked) {
            if (!disabledArray.includes(channelId)) {
                disabledArray.push(channelId);
            }
        } else {
            disabledArray = disabledArray.filter(id => id !== channelId);
        }
        this.disabledChannelIds = disabledArray.join(',');

        try {
            const payload = {
                agentKeyword: this.agentKeyword,
                confirmationText: this.confirmationText,
                reactivationKeyword: this.reactivationKeyword,
                reminderEnabled: this.reminderEnabled,
                reminderMinutes: this.reminderMinutes,
                reminderTemplate: this.reminderTemplate,
                isGlobal: this.isGlobal,
                autoQueueDetector: this.autoQueueDetector,
                detectJoinedAgent: this.detectJoinedAgent,
                useFlowRouting: this.useFlowRouting,
                selectedMessagingChannelId: this.selectedMessagingChannelId,
                targetGroupId: this.targetGroupId,
                disabledChannelIds: this.disabledChannelIds
            };
            const res = await saveAgentNotificationConfig({ payload: payload });
            if (res && res.success) {
                this.showStatusAlert(isChecked ? '🚫 Channel disabled for topbar system.' : '✅ Channel enabled for topbar system.');
                await this.loadRealSystemDetections();
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error toggling channel disabled state:', err);
        }
    }

    async handleSaveConfig() {
        this.statusAlertMessage = '';
        try {
            const payload = {
                agentKeyword: this.agentKeyword,
                confirmationText: this.confirmationText,
                reactivationKeyword: this.reactivationKeyword,
                reminderEnabled: this.reminderEnabled,
                reminderMinutes: this.reminderMinutes,
                reminderTemplate: this.reminderTemplate,
                isGlobal: this.isGlobal,
                autoQueueDetector: this.autoQueueDetector,
                detectJoinedAgent: this.detectJoinedAgent,
                useFlowRouting: this.useFlowRouting,
                selectedMessagingChannelId: this.selectedMessagingChannelId,
                targetGroupId: this.targetGroupId,
                disabledChannelIds: this.disabledChannelIds
            };
            const res = await saveAgentNotificationConfig({ payload: payload });
            if (res && res.success) {
                this.showStatusAlert('✅ Configuration saved successfully!');
            } else {
                this.showStatusAlert('❌ Error saving configuration: ' + (res ? res.message : 'Unknown error'));
            }
        } catch (err) {
            this.showStatusAlert('❌ Exception saving configuration: ' + (err.body ? err.body.message : err.message));
        }
    }

    async handleSimulateSessionTargeting() {
        this.statusAlertMessage = '';
        try {
            const res = await getSimulatedAgentTargetingDetails();
            if (res) {
                this.simulationResult = res;
                if (res.hasSessions) {
                    this.showStatusAlert(`Evaluated ${res.sessions.length} active/recent MessagingSession records.`);
                } else {
                    this.showStatusAlert(res.message || 'No active messaging sessions found.');
                }
            }
        } catch (err) {
            console.error('[TopNotificationAdmin] Error simulating session targeting:', err);
            this.showStatusAlert('❌ Exception evaluating active sessions: ' + (err.body ? err.body.message : err.message));
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
