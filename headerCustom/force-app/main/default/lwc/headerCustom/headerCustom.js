import { LightningElement, api, track } from 'lwc';
import { dispatchMessagingEvent, assignMessagingEventHandler, MESSAGING_EVENT } from 'lightningsnapin/eventStore';

function runAaScript() {
    try {
        (function () {
          if (typeof window === 'undefined' || typeof document === 'undefined') return;

          function getLinkMessageContainer(node) {
            try {
              let curr = node;
              while (curr) {
                if (curr.tagName && curr.tagName.toLowerCase() === 'embeddedmessaging-conversation-link-message') {
                  return curr;
                }
                if (curr.closest) {
                  const found = curr.closest('embeddedmessaging-conversation-link-message');
                  if (found) return found;
                }
                curr = curr.parentNode || (curr.getRootNode && curr.getRootNode() !== curr ? curr.getRootNode().host : null);
              }
            } catch (e) {}
            return null;
          }

          function isTubotLatMessage(container) {
            if (!container || !container.tagName || container.tagName.toLowerCase() !== 'embeddedmessaging-conversation-link-message') {
              return false;
            }
            try {
              // 1. Check href attribute of <a> tags inside this specific link message
              const anchors = container.querySelectorAll ? container.querySelectorAll('a') : [];
              for (let i = 0; i < anchors.length; i++) {
                const href = anchors[i].getAttribute('href') || anchors[i].href || '';
                if (href.toLowerCase().includes('tubot.lat')) {
                  return true;
                }
              }

              // 2. Check text content of .linkUrlDomain element
              const domainEl = container.querySelector ? container.querySelector('.linkUrlDomain, [class*="linkUrlDomain"]') : null;
              if (domainEl && (domainEl.textContent || '').toLowerCase().includes('tubot.lat')) {
                return true;
              }

              // 3. Check visible text content of the link message (excluding script/HTML tags)
              const visibleText = (container.textContent || container.innerText || '').toLowerCase();
              if (visibleText.includes('tubot.lat')) {
                return true;
              }
            } catch (e) {}
            return false;
          }
        
          function cleanContainer(root) {
            if (!root) return;
            try {
              // 1. Process embeddedmessaging-conversation-link-message containers
              const linkMessages = root.querySelectorAll
                ? root.querySelectorAll('embeddedmessaging-conversation-link-message')
                : [];

              linkMessages.forEach(container => {
                try {
                  if (isTubotLatMessage(container)) {
                    // Remove <br> tags
                    const brs = [];
                    if (container.querySelectorAll) brs.push(...container.querySelectorAll('br'));
                    if (container.shadowRoot && container.shadowRoot.querySelectorAll) brs.push(...container.shadowRoot.querySelectorAll('br'));
                    brs.forEach(br => {
                      try { br.remove(); } catch (e) { if (br.parentNode) br.parentNode.removeChild(br); }
                    });

                    // Remove domain text & icon containers (.linkUrlDomain, .linkIconContainer)
                    const subElements = [];
                    if (container.querySelectorAll) subElements.push(...container.querySelectorAll('.linkUrlDomain, [class*="linkUrlDomain"], .linkIconContainer, [class*="linkIconContainer"]'));
                    if (container.shadowRoot && container.shadowRoot.querySelectorAll) subElements.push(...container.shadowRoot.querySelectorAll('.linkUrlDomain, [class*="linkUrlDomain"], .linkIconContainer, [class*="linkIconContainer"]'));
                    subElements.forEach(el => {
                      try { el.remove(); } catch (e) { if (el.parentNode) el.parentNode.removeChild(el); }
                    });

                    // Strip href and disable navigation on <a> tags without removing the <a> element (which wraps the card)
                    const anchors = [];
                    if (container.querySelectorAll) anchors.push(...container.querySelectorAll('a'));
                    if (container.shadowRoot && container.shadowRoot.querySelectorAll) anchors.push(...container.shadowRoot.querySelectorAll('a'));
                    anchors.forEach(a => {
                      try {
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
                      } catch (e) {}
                    });
                  }
                } catch (e) {}
              });

              // 2. Also check standalone <br> elements inside matching containers
              const brTargets = root.querySelectorAll ? root.querySelectorAll('br') : [];
              brTargets.forEach(br => {
                try {
                  const container = getLinkMessageContainer(br);
                  if (container && isTubotLatMessage(container)) {
                    try {
                      br.remove();
                    } catch (e) {
                      if (br.parentNode) br.parentNode.removeChild(br);
                    }
                  }
                } catch (e) {}
              });

              // 3. Recurse into all Shadow DOMs
              const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
              allElements.forEach(el => {
                try {
                  if (el.shadowRoot) {
                    scanDocumentAndIframes(el.shadowRoot);
                  }
                } catch (e) {}
              });
            } catch (e) {}
          }
        
          function scanDocumentAndIframes(winOrDoc) {
            let doc;
            try {
              doc = winOrDoc.document || winOrDoc;
            } catch (e) {
              return; // Cross-origin iframe boundary
            }
        
            if (!doc) return;
        
            try {
              cleanContainer(doc);
            } catch (e) {}

            // Recurse into all <iframe> containers (Salesforce chat frames)
            try {
              const iframes = doc.querySelectorAll ? doc.querySelectorAll('iframe, frame') : [];
              iframes.forEach(iframe => {
                try {
                  const frameDoc = iframe.contentDocument || iframe.contentWindow?.document;
                  if (frameDoc) scanDocumentAndIframes(frameDoc);
                } catch (e) {}
              });
            } catch (e) {}
          }

          function masterScan() {
            try {
              scanDocumentAndIframes(window);
            } catch (e) {}
          }

          // 1. Immediate execution
          masterScan();

          // 2. MutationObserver for DOM additions
          try {
            const observer = new MutationObserver(() => masterScan());
            if (document.documentElement) {
              observer.observe(document.documentElement, { childList: true, subtree: true });
            }
          } catch (e) {}

          // 3. Lightweight 500ms poller (handles refreshes, iframe reloads, new chat messages)
          try {
            setInterval(masterScan, 500);
          } catch (e) {}

          return "Universal MIAW Link Cleaner Active!";
        })();
    } catch (e) {
        console.error("Error executing runAaScript:", e);
    }
}

// Execute at module load safely
try {
    runAaScript();
} catch (e) {
    console.error("Module load runAaScript error:", e);
}

export default class HeaderCustom extends LightningElement {
    @api configuration = {};
    @api conversationStatus;

    @track dynamicTitle = '';
    @track isMenuOpen = false;

    connectedCallback() {
        try {
            runAaScript();
        } catch (e) {
            console.error("connectedCallback runAaScript error:", e);
        }

        try {
            // Dynamically update header text when agent joins or event fires (e.g. payload: { text: "Ivan J" })
            if (typeof assignMessagingEventHandler === 'function' && MESSAGING_EVENT?.UPDATE_HEADER_TEXT) {
                assignMessagingEventHandler(MESSAGING_EVENT.UPDATE_HEADER_TEXT, (payload) => {
                    console.log("Header text update event received:", payload);
                    if (payload && payload.text) {
                        this.dynamicTitle = payload.text;
                    }
                });
            }
        } catch (e) {
            console.error("Error setting up messaging event handler:", e);
        }
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
        try {
            if (typeof dispatchMessagingEvent === 'function' && MESSAGING_EVENT?.CLOSE_CONVERSATION) {
                dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONVERSATION, {});
            }
        } catch (e) {
            console.error("Error closing conversation:", e);
        }
    }

    onMinimizeButtonClick() {
        try {
            if (typeof dispatchMessagingEvent === 'function' && MESSAGING_EVENT?.MINIMIZE_BUTTON_CLICK) {
                dispatchMessagingEvent(MESSAGING_EVENT.MINIMIZE_BUTTON_CLICK, {});
            }
        } catch (e) {
            console.error("Error minimizing:", e);
        }
    }

    onCloseButtonClick() {
        try {
            if (typeof dispatchMessagingEvent === 'function' && MESSAGING_EVENT?.CLOSE_CONTAINER) {
                dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONTAINER, {});
            }
        } catch (e) {
            console.error("Error closing container:", e);
        }
    }
}
