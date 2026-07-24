import { LightningElement, api, track } from 'lwc';
import { dispatchMessagingEvent, assignMessagingEventHandler, MESSAGING_EVENT } from 'lightningsnapin/eventStore';
import handleIncomingTurn from '@salesforce/apex/HeaderCustomController.handleIncomingTurn';

/**
 * Phase 2 Helper Function: Parses event payload produced during chat turn,
 * extracting session identifier and raw text payload.
 */
function extractTurnPayload(eventOrPayload) {
    let sessionId = '';
    let messageText = '';
    if (!eventOrPayload) return { sessionId, messageText };

    const payload = eventOrPayload.detail || eventOrPayload;
    sessionId = payload.conversationId || payload.sessionId || payload.recordId || payload.conversationSessionId || '';
    messageText = payload.text || payload.message || payload.content || payload.body || '';

    return { sessionId, messageText };
}

/**
 * Phase 2 Helper Function: Bridges client-side event to Salesforce application tier
 * over internal Lightning transport bus (0 REST API calls consumed).
 */
function sendApexTurnBridge(sessionId, messageText) {
    console.log('[HeaderCustom-Debug] Invoking sendApexTurnBridge with:', { sessionId, messageText });
    if (!sessionId || !messageText) {
        console.warn('[HeaderCustom-Debug] Skipped sendApexTurnBridge: missing sessionId or messageText', { sessionId, messageText });
        return;
    }
    handleIncomingTurn({ sessionId: sessionId, messageText: messageText })
        .then(result => {
            console.log('[HeaderCustom-Debug] Apex turn handler result:', result);
        })
        .catch(error => {
            console.error('[HeaderCustom-Debug] Apex invocation error:', error);
        });
}

function runAaScript() {
    try {
        (function () {
          if (typeof window === 'undefined' || typeof document === 'undefined') return;

          // Attach Client-Side Event Listener for Embedded Messaging Events & PostMessage
          try {
            const handleTurnEvent = (evt) => {
              try {
                console.log('[HeaderCustom-Debug] Captured client-side event:', evt.type, evt.detail);
                const { sessionId, messageText } = extractTurnPayload(evt);
                const activeSession = sessionId || findSessionIdInWindow();
                if (messageText) {
                  sendApexTurnBridge(activeSession, messageText);
                }
              } catch (err) {
                console.error('[HeaderCustom-Debug] Error processing turn event listener:', err);
              }
            };

            window.addEventListener('embeddedmessaging-message-sent', handleTurnEvent);
            window.addEventListener('onmessagingevent', handleTurnEvent);
            document.addEventListener('embeddedmessaging-message-sent', handleTurnEvent);

            window.addEventListener('message', (evt) => {
              try {
                if (!evt.data) return;
                const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
                if (data.type === 'embeddedmessaging-message-sent' || data.event === 'MESSAGE_SENT' || (data.messageText && data.conversationId)) {
                  console.log('[HeaderCustom-Debug] Captured postMessage turn event:', data);
                  const sessionId = data.conversationId || findSessionIdInWindow();
                  const text = data.text || data.messageText || data.message || '';
                  if (text) {
                    sendApexTurnBridge(sessionId, text);
                  }
                }
              } catch (e) {}
            });
          } catch (e) {
            console.error('[HeaderCustom-Debug] Error registering client-side turn event listeners:', e);
          }

          function findSessionIdInWindow() {
            try {
              if (window.embedded_svc?.settings?.conversationId) return window.embedded_svc.settings.conversationId;
              if (window.embeddedmessaging?.conversationId) return window.embeddedmessaging.conversationId;
              for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.toLowerCase().includes('conversation')) {
                  const val = sessionStorage.getItem(key);
                  if (val && val.length > 10) return val;
                }
              }
            } catch (e) {}
            return 'ACTIVE_SESSION';
          }

          function processUserMessages(root) {
            if (!root || !root.querySelectorAll) return;
            try {
              // Target MIAW user message components / bubbles
              const userMessages = root.querySelectorAll(
                'embeddedmessaging-chat-message[data-message-type="user"], ' +
                'embeddedmessaging-chat-message[data-author-type="user"], ' +
                '[class*="userMessage"], [class*="outboundMessage"], [data-author="User"]'
              );

              userMessages.forEach(msgEl => {
                if (msgEl.dataset && msgEl.dataset.turnProcessed) return;
                try { msgEl.dataset.turnProcessed = 'true'; } catch (e) {}

                const text = (msgEl.textContent || msgEl.innerText || '').trim();
                const sessionId = findSessionIdInWindow();
                if (text) {
                  console.log('[HeaderCustom-Debug] Captured DOM user message bubble:', { text, sessionId });
                  sendApexTurnBridge(sessionId, text);
                }
              });
            } catch (e) {}
          }

          function hookChatInputs(root) {
            if (!root || !root.querySelectorAll) return;
            try {
              // 1. Process user message bubbles in DOM (fail-safe fallback)
              processUserMessages(root);

              // 2. Hook Input Elements with continuous tracking & capture phase listeners
              const inputs = root.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], embeddedmessaging-chat-input');
              inputs.forEach(el => {
                if (el.dataset && el.dataset.turnHooked) return;
                try { el.dataset.turnHooked = 'true'; } catch (e) {}

                console.log('[HeaderCustom-Debug] Hooked chat input element:', el);

                // Continuously track typed text before clearing
                const updateTypedText = () => {
                  const val = el.value || el.textContent || el.innerText || '';
                  if (val && val.trim().length > 0) {
                    el._lastTypedText = val.trim();
                  }
                };

                el.addEventListener('input', updateTypedText, true);
                el.addEventListener('keyup', updateTypedText, true);
                el.addEventListener('change', updateTypedText, true);

                const triggerSend = () => {
                  const text = el.value || el._lastTypedText || el.textContent || el.innerText || '';
                  const sessionId = findSessionIdInWindow();
                  if (text && text.trim().length > 0) {
                    console.log('[HeaderCustom-Debug] Captured input turn submit:', { text: text.trim(), sessionId });
                    sendApexTurnBridge(sessionId, text.trim());
                    el._lastTypedText = '';
                  }
                };

                // Capture phase keydown (runs BEFORE Salesforce clears the input value!)
                el.addEventListener('keydown', (e) => {
                  updateTypedText();
                  if (e.key === 'Enter' && !e.shiftKey) {
                    triggerSend();
                  }
                }, true);
              });

              // 3. Hook Send Buttons with capture phase listeners
              const sendBtns = root.querySelectorAll('button[class*="send"], button[aria-label*="Send"], button[title*="Send"], [data-id="sendMessageButton"]');
              sendBtns.forEach(btn => {
                if (btn.dataset && btn.dataset.btnHooked) return;
                try { btn.dataset.btnHooked = 'true'; } catch (e) {}

                console.log('[HeaderCustom-Debug] Hooked send button:', btn);

                const handleBtnClick = () => {
                  const activeDoc = btn.ownerDocument || document;
                  const input = activeDoc.querySelector('textarea, input[type="text"], [contenteditable="true"]');
                  const text = input ? (input.value || input._lastTypedText || input.textContent || '') : '';
                  const sessionId = findSessionIdInWindow();
                  if (text && text.trim().length > 0) {
                    console.log('[HeaderCustom-Debug] Captured button turn submit:', { text: text.trim(), sessionId });
                    sendApexTurnBridge(sessionId, text.trim());
                    if (input) input._lastTypedText = '';
                  }
                };

                btn.addEventListener('mousedown', handleBtnClick, true);
                btn.addEventListener('pointerdown', handleBtnClick, true);
                btn.addEventListener('click', handleBtnClick, true);
              });
            } catch (e) {}
          }


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
              hookChatInputs(doc);
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

            // Register turn handler for Messaging events via Lightning eventStore
            if (typeof assignMessagingEventHandler === 'function') {
                const turnEvents = ['MESSAGE_SENT', 'RECORD_EVENT', 'CONVERSATION_PAYLOAD'];
                turnEvents.forEach(evtName => {
                    if (MESSAGING_EVENT?.[evtName] || evtName) {
                        assignMessagingEventHandler(MESSAGING_EVENT?.[evtName] || evtName, (payload) => {
                            const { sessionId, messageText } = extractTurnPayload(payload);
                            const activeSession = sessionId || this.configuration?.conversationId || this.configuration?.recordId;
                            if (activeSession && messageText) {
                                sendApexTurnBridge(activeSession, messageText);
                            }
                        });
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
