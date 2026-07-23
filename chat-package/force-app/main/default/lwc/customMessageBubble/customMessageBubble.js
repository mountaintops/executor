import { LightningElement, api } from 'lwc';

export default class CustomMessageBubble extends LightningElement {
    static renderMode = 'light';

    @api message;

    connectedCallback() {
        this.injectMinimalPaddingCSS();
    }

    injectMinimalPaddingCSS() {
        const styleId = 'miaw-minimal-padding-override';
        let style = document.getElementById(styleId);
        if (!style) {
            style = document.createElement('style');
            style.id = styleId;
            document.head.appendChild(style);
        }

        style.textContent = `
            /* Hide top icon container */
            .linkIconContainer,
            .conversation-link-message__panel .linkIconContainer,
            div[class*="linkIconContainer"],
            lightning-icon[icon-name="utility:link"] {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
                visibility: hidden !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            /* Compact panel styling with minimal padding */
            .conversation-link-message__panel {
                background-color: #f1f5f9 !important;
                border: 1px solid #cbd5e1 !important;
                border-radius: 12px 12px 12px 2px !important;
                padding: 4px 8px !important;
                margin: 0 !important;
                box-shadow: none !important;
                display: inline-block !important;
            }

            /* Strip inner content padding & extra line breaks */
            .conversation-link-message__content {
                font-size: 14px !important;
                color: #0f172a !important;
                padding: 0 !important;
                margin: 0 !important;
                line-height: 1.3 !important;
            }

            .conversation-link-message__content span {
                padding: 0 !important;
                margin: 0 !important;
            }

            .conversation-link-message__content br {
                display: none !important;
            }

            .linkUrlDomain {
                color: #2563eb !important;
                text-decoration: underline !important;
                font-weight: 500 !important;
                margin-left: 4px !important;
            }
        `;
    }

    get isUserMessage() {
        if (!this.message) {
            return false;
        }
        const direction = this.message.direction ? String(this.message.direction).toLowerCase() : '';
        const actorType = this.message.actorType ? String(this.message.actorType).toLowerCase() : '';
        return direction === 'inbound' || actorType === 'enduser' || actorType === 'user';
    }

    get containerClass() {
        return this.isUserMessage 
            ? 'custom-bubble-container right-aligned' 
            : 'custom-bubble-container left-aligned';
    }

    get bubbleClass() {
        return this.isUserMessage 
            ? 'custom-chat-bubble user-bubble' 
            : 'custom-chat-bubble system-bubble';
    }

    get rawText() {
        if (!this.message) {
            return '';
        }
        if (typeof this.message === 'string') {
            return this.message;
        }
        if (this.message.content) {
            return this.message.content;
        }
        if (this.message.value) {
            return this.message.value;
        }
        if (this.message.text) {
            return this.message.text;
        }
        return '';
    }

    get sanitizedMessageText() {
        let text = this.rawText;
        if (!text) {
            return '';
        }
        return text.replace(/<img[^>]*>/gi, '')
                   .replace(/<figure[^>]*>.*?<\/figure>/gi, '');
    }
}
