import { LightningElement, api, track } from 'lwc';
import { dispatchMessagingEvent, assignMessagingEventHandler, MESSAGING_EVENT } from 'lightningsnapin/eventStore';

function runAaScript() {
    (function () {
      // CSS rule ignoring dynamic hashes and targeting only standard classes
      const HIDE_CSS = `
        .linkIconContainer,
        [class*="linkIconContainer"],
        .linkUrlDomain,
        [class*="linkUrlDomain"],
        br:has(+ .linkUrlDomain),
        br:has(+ [class*="linkUrlDomain"]) {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          max-height: 0 !important;
          max-width: 0 !important;
          height: 0 !important;
          width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          pointer-events: none !important;
        }
      `;
    
      // WeakSet ensures each element is processed exactly ONCE (0% CPU impact)
      const processed = new WeakSet();
    
      function injectCSS(docOrShadow) {
        try {
          if (!docOrShadow || docOrShadow.querySelector?.('#miaw-global-hide')) return;
          const style = document.createElement('style');
          style.id = 'miaw-global-hide';
          style.textContent = HIDE_CSS;
          (docOrShadow.head || docOrShadow).appendChild(style);
        } catch (e) {}
      }
    
      function cleanContainer(root) {
        if (!root) return;
    
        injectCSS(root);
    
        // 1. Hide .linkIconContainer
        const icons = root.querySelectorAll ? root.querySelectorAll('.linkIconContainer, [class*="linkIconContainer"]') : [];
        icons.forEach(icon => {
          if (!processed.has(icon)) {
            processed.add(icon);
            icon.style.cssText = 'display: none !important; visibility: hidden !important; width: 0 !important; height: 0 !important;';
          }
        });
    
        // 2. Hide .linkUrlDomain and preceding <br>
        const domains = root.querySelectorAll ? root.querySelectorAll('.linkUrlDomain, [class*="linkUrlDomain"]') : [];
        domains.forEach(domain => {
          if (!processed.has(domain)) {
            processed.add(domain);
            domain.style.cssText = 'display: none !important; visibility: hidden !important; width: 0 !important; height: 0 !important;';
    
            let prev = domain.previousSibling;
            while (prev && prev.nodeType === 3 && !prev.textContent.trim()) {
              prev = prev.previousSibling;
            }
            if (prev && prev.nodeName === 'BR') {
              prev.style.cssText = 'display: none !important;';
            }
          }
        });
    
        // 3. Strip href on <a> tags inside embeddedmessaging-conversation-link-message
        const anchors = root.querySelectorAll ? root.querySelectorAll('a') : [];
        anchors.forEach(a => {
          const isTarget = a.querySelector?.('.linkIconContainer, .linkUrlDomain, [class*="linkIconContainer"], [class*="linkUrlDomain"]') ||
                           a.closest?.('embeddedmessaging-conversation-link-message, [class*="conversation-link-message"]') ||
                           (a.parentElement && a.parentElement.tagName === 'EMBEDDEDMESSAGING-CONVERSATION-LINK-MESSAGE');
    
          if (isTarget && !processed.has(a)) {
            processed.add(a);
            a.removeAttribute('href');
            a.removeAttribute('target');
            a.removeAttribute('title');
            a.removeAttribute('data-navigation-href');
            a.style.pointerEvents = 'none';
            a.style.cursor = 'default';
            a.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              return false;
            };
          }
        });
    
        // 4. Recurse into all Shadow DOMs
        const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        allElements.forEach(el => {
          if (el.shadowRoot) {
            scanDocumentAndIframes(el.shadowRoot);
          }
        });
      }
    
      function scanDocumentAndIframes(winOrDoc) {
        let doc;
        try {
          doc = winOrDoc.document || winOrDoc;
        } catch (e) {
          return; // Cross-origin iframe boundary
        }
    
        if (!doc) return;
    
        cleanContainer(doc);

        // Recurse into all <iframe> containers (Salesforce chat frames)
        try {
          const iframes = doc.querySelectorAll('iframe, frame');
          iframes.forEach(iframe => {
            try {
              const frameDoc = iframe.contentDocument || iframe.contentWindow?.document;
              if (frameDoc) scanDocumentAndIframes(frameDoc);
            } catch (e) {}
          });
        } catch (e) {}
      }

      function masterScan() {
        scanDocumentAndIframes(window);
      }

      // 1. Immediate execution
      masterScan();

      // 2. MutationObserver for DOM additions
      const observer = new MutationObserver(() => masterScan());
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }

      // 3. Lightweight 500ms poller (handles refreshes, iframe reloads, new chat messages)
      setInterval(masterScan, 500);

      return "Universal MIAW Link Cleaner Active!";
    })();
}

// Execute at module load
runAaScript();

export default class HeaderCustom extends LightningElement {
    @api configuration = {};
    @api conversationStatus;

    @track dynamicTitle = '';
    @track isMenuOpen = false;

    connectedCallback() {
        runAaScript();

        // Dynamically update header text when agent joins or event fires (e.g. payload: { text: "Ivan J" })
        assignMessagingEventHandler(MESSAGING_EVENT.UPDATE_HEADER_TEXT, (payload) => {
            console.log("Header text update event received:", payload);
            if (payload && payload.text) {
                this.dynamicTitle = payload.text;
            }
        });
    }

    get headerTitle() {
        return this.dynamicTitle || this.configuration?.headerText || this.configuration?.messagingChannelName || 'Chat Support';
    }

    toggleMenu() {
        this.isMenuOpen = !this.isMenuOpen;
    }

    handleEndConversation() {
        this.isMenuOpen = false;
        console.log("Ending conversation...");
        dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONVERSATION, {});
    }

    onMinimizeButtonClick() {
        dispatchMessagingEvent(MESSAGING_EVENT.MINIMIZE_BUTTON_CLICK, {});
    }

    onCloseButtonClick() {
        dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONTAINER, {});
    }
}
