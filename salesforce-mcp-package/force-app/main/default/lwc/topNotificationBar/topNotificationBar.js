import { LightningElement, track, api } from 'lwc';
import Id from '@salesforce/user/Id';
import getActiveNotificationForCurrentUser from '@salesforce/apex/TopNotificationController.getActiveNotificationForCurrentUser';

// Neutralize any native browser Notification.requestPermission() calls from external scripts
if (typeof window !== 'undefined' && window.Notification) {
    try {
        window.Notification.requestPermission = function() {
            return Promise.resolve('denied');
        };
    } catch (e) {}
}

const GLOBAL_BANNER_ID = 'salesforce_global_top_notification_bar_container';

export default class TopNotificationBar extends LightningElement {
    @api label = 'Top Notification Bar';
    @api icon = 'utility:announcement';

    @track notificationId = '';
    @track title = '';
    @track message = '';
    @track theme = 'info';
    @track isVisible = false;
    @track isDismissible = true;
    @track isGlobal = true;

    currentUserId = Id;
    pollerInterval = null;
    domWatchdogInterval = null;

    connectedCallback() {
        console.log(`[TopNotificationBar:INIT] Component initialized for user ${this.currentUserId} in window frame:`, window.location.href);
        this.loadActiveNotification();

        // 3-second Apex polling loop
        try {
            this.pollerInterval = setInterval(() => {
                this.loadActiveNotification();
            }, 3000);
        } catch (e) {
            console.error('[TopNotificationBar:ERROR] Failed to start poller interval:', e);
        }

        // 1-second DOM watchdog timer to enforce top overlay positioning during SPA navigation
        try {
            this.domWatchdogInterval = setInterval(() => {
                if (this.isVisible && this.notificationId) {
                    this.syncGlobalBannerDOM();
                }
            }, 1000);
        } catch (e) {}
    }

    disconnectedCallback() {
        console.log('[TopNotificationBar:DESTROY] Component unmounting.');
        if (this.pollerInterval) {
            clearInterval(this.pollerInterval);
            this.pollerInterval = null;
        }
        if (this.domWatchdogInterval) {
            clearInterval(this.domWatchdogInterval);
            this.domWatchdogInterval = null;
        }
        this.removeGlobalBanner();
    }

    renderedCallback() {
        if (this.isVisible && this.notificationId) {
            this.syncGlobalBannerDOM();
        } else {
            this.removeGlobalBanner();
        }
    }

    async loadActiveNotification() {
        try {
            const res = await getActiveNotificationForCurrentUser();
            if (res && res.hasNotification && res.notification) {
                const notif = res.notification;
                console.log('[TopNotificationBar:APEX_RESPONSE] Active notification found:', notif);
                if (!this.isDismissedInSession(notif.id)) {
                    this.setNotificationState(notif);
                } else if (this.notificationId === notif.id) {
                    console.log('[TopNotificationBar:INFO] Notification dismissed in session, hiding banner.');
                    this.isVisible = false;
                    this.removeGlobalBanner();
                }
            } else {
                if (this.isVisible) {
                    console.log('[TopNotificationBar:INFO] No active notification found. Hiding banner.');
                }
                this.isVisible = false;
                this.removeGlobalBanner();
            }
        } catch (err) {
            console.error('[TopNotificationBar:ERROR] Apex call getActiveNotificationForCurrentUser failed:', err);
        }
    }

    setNotificationState(notif) {
        this.notificationId = notif.id;
        this.title = notif.title || '';
        this.message = notif.message || '';
        this.theme = (notif.theme || 'info').toLowerCase();
        this.isDismissible = notif.isDismissible !== false;
        this.isGlobal = notif.isGlobal === true;
        this.isVisible = true;
        this.syncGlobalBannerDOM();
    }

    isDismissedInSession(id) {
        try {
            if (!id) return false;
            return sessionStorage.getItem('topNotifDismissed_' + id) === 'true';
        } catch (e) {
            return false;
        }
    }

    handleDismiss() {
        console.log('[TopNotificationBar:USER_ACTION] User dismissed notification ID:', this.notificationId);
        this.isVisible = false;
        this.removeGlobalBanner();
        try {
            if (this.notificationId) {
                sessionStorage.setItem('topNotifDismissed_' + this.notificationId, 'true');
            }
        } catch (e) {}
    }

    /**
     * Multi-tier Fallback Target Document Resolver:
     * Tier 1: window.top.document
     * Tier 2: window.parent.document
     * Tier 3: document (local frame)
     */
    getTargetDocument() {
        let currentWin = window;
        let bestDoc = document;

        try {
            if (window.top && window.top.document) {
                bestDoc = window.top.document;
                return bestDoc;
            }
        } catch (e) {
            console.warn('[TopNotificationBar:FALLBACK] window.top.document restricted by LWS/CORS, checking parent frame...');
        }

        while (currentWin.parent && currentWin.parent !== currentWin) {
            try {
                if (currentWin.parent.document) {
                    bestDoc = currentWin.parent.document;
                    currentWin = currentWin.parent;
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }

        return bestDoc;
    }

    syncGlobalBannerDOM() {
        try {
            const doc = this.getTargetDocument();
            if (!doc || !doc.body) {
                console.warn('[TopNotificationBar:WARN] Target document body unavailable for portal sync.');
                return;
            }

            let banner = doc.getElementById(GLOBAL_BANNER_ID);
            if (!banner) {
                banner = doc.createElement('div');
                banner.id = GLOBAL_BANNER_ID;
                doc.body.appendChild(banner);
                console.log('[TopNotificationBar:PORTAL] Injected global top banner element into document body:', doc);
            }

            const themeStyles = {
                info: 'background: linear-gradient(135deg, #0176d3 0%, #0b5cab 100%); color: #ffffff; border-bottom: 2px solid #005fb2;',
                warning: 'background: linear-gradient(135deg, #fe9339 0%, #dd7a01 100%); color: #080707; border-bottom: 2px solid #c26900;',
                error: 'background: linear-gradient(135deg, #ea001e 0%, #ba0517 100%); color: #ffffff; border-bottom: 2px solid #930312;',
                danger: 'background: linear-gradient(135deg, #ea001e 0%, #ba0517 100%); color: #ffffff; border-bottom: 2px solid #930312;',
                success: 'background: linear-gradient(135deg, #2e844a 0%, #1b5e20 100%); color: #ffffff; border-bottom: 2px solid #144918;'
            };

            const selectedStyle = themeStyles[this.theme] || themeStyles.info;

            banner.style.cssText = `
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                right: 0 !important;
                z-index: 2147483647 !important;
                width: 100% !important;
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3) !important;
                font-family: 'Salesforce Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                box-sizing: border-box !important;
                display: block !important;
                ${selectedStyle}
            `;

            const dismissBtnHTML = this.isDismissible ? `
                <button id="${GLOBAL_BANNER_ID}_dismiss" style="
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    padding: 4px 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    margin-left: auto;
                    color: inherit;
                    font-size: 16px;
                    font-weight: bold;
                    opacity: 0.9;
                " title="Dismiss">✕</button>
            ` : '';

            banner.innerHTML = `
                <div style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 10px 24px;
                    gap: 12px;
                    max-width: 1400px;
                    margin: 0 auto;
                ">
                    <span style="font-size: 18px; line-height: 1;">📢</span>
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 1.4; word-break: break-word; text-align: center;">
                        ${this.title ? `<strong style="font-weight: 700;">${this.escapeHTML(this.title)}:</strong>` : ''}
                        <span>${this.escapeHTML(this.message)}</span>
                    </div>
                    ${dismissBtnHTML}
                </div>
            `;

            if (this.isDismissible) {
                const btn = doc.getElementById(`${GLOBAL_BANNER_ID}_dismiss`);
                if (btn) {
                    btn.onclick = () => {
                        this.handleDismiss();
                    };
                }
            }
        } catch (e) {
            console.error('[TopNotificationBar:ERROR] Exception in syncGlobalBannerDOM:', e);
        }
    }

    removeGlobalBanner() {
        try {
            const doc = this.getTargetDocument();
            if (doc) {
                const banner = doc.getElementById(GLOBAL_BANNER_ID);
                if (banner && banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                    console.log('[TopNotificationBar:PORTAL] Removed global top banner from document.');
                }
            }
        } catch (e) {}
    }

    escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    get containerClass() {
        return `top-notification-bar theme-${this.theme}`;
    }

    get containerStyle() {
        return `position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; z-index: 2147483647 !important; width: 100vw !important;`;
    }

    get isInfo() { return this.theme === 'info'; }
    get isWarning() { return this.theme === 'warning'; }
    get isError() { return this.theme === 'error' || this.theme === 'danger'; }
    get isSuccess() { return this.theme === 'success'; }
}
