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
    
    if (typeof payload === 'string') {
        messageText = payload;
    } else if (payload) {
        messageText = payload.text || payload.message || payload.content || payload.body || payload.messageText || '';
        if (typeof messageText === 'object' && messageText !== null) {
            messageText = messageText.text || messageText.content || messageText.body || '';
        }
    }

    return { sessionId, messageText: String(messageText || '').trim() };
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

function findMessageListInRoots(root) {
    if (!root) return null;
    try {
        const selectors = [
            'embeddedmessaging-chat-message-list',
            '[class*="chat-message-list"]',
            '[class*="messageList"]',
            '.slds-chat-list',
            'main[class*="chat"]',
            'div[class*="conversation-body"]'
        ];
        for (let i = 0; i < selectors.length; i++) {
            const found = root.querySelector ? root.querySelector(selectors[i]) : null;
            if (found) return found;
        }

        // Search Shadow DOMs recursively
        const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            if (el.shadowRoot) {
                const res = findMessageListInRoots(el.shadowRoot);
                if (res) return res;
            }
        }

        // Search IFrames recursively
        const iframes = root.querySelectorAll ? root.querySelectorAll('iframe, frame') : [];
        for (let i = 0; i < iframes.length; i++) {
            try {
                const frameDoc = iframes[i].contentDocument || iframes[i].contentWindow?.document;
                if (frameDoc) {
                    const res = findMessageListInRoots(frameDoc);
                    if (res) return res;
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

/**
 * Transforms standard Salesforce automated response notification elements
 * in-place into clean, left-aligned Agent Message Bubbles with profile picture,
 * agent name, and timestamp.
 */
function transformNotificationsToBubbles(root) {
    if (!root || !root.querySelectorAll) return;
    try {
        const notificationItems = root.querySelectorAll(
            '.embedded-messaging-automated-response, ' +
            '[class*="embedded-messaging-automated-response"], ' +
            'li.slds-chat-listitem_event'
        );

        // Helper to resolve active agent name from header or configuration
        let agentName = 'Agent';
        try {
            const doc = root.ownerDocument || document;
            const headerTitle = doc.querySelector('.header-title, [class*="header-title"]');
            if (headerTitle && headerTitle.textContent && headerTitle.textContent.trim()) {
                agentName = headerTitle.textContent.trim();
            }
        } catch (e) {}

        // Helper to resolve formatted time string
        const now = new Date();
        const defaultTimeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

        notificationItems.forEach(el => {
            if (el.dataset && el.dataset.bubbleTransformed === 'true') return;

            // Find parent li element
            let li = el.tagName && el.tagName.toLowerCase() === 'li' ? el : el.closest('li');
            if (!li && el.parentNode) {
                li = el.parentNode;
            }

            if (!li) return;
            if (li.dataset && li.dataset.bubbleTransformed === 'true') return;

            // Locate target text span inside automated response container
            const autoResp = li.querySelector ? (li.querySelector('.embedded-messaging-automated-response, [class*="embedded-messaging-automated-response"]') || el) : el;
            const span = autoResp.querySelector ? autoResp.querySelector('span') : null;
            const rawText = span ? span.innerHTML : (autoResp.textContent || '').trim();

            if (!rawText) return;

            // ONLY affect text notifications that contain "tubot.lat"
            if (!rawText.toLowerCase().includes('tubot.lat')) return;

            // Mark both elements to prevent re-processing only after verifying "tubot.lat" presence
            try {
                if (el.dataset) el.dataset.bubbleTransformed = 'true';
                if (li.dataset) li.dataset.bubbleTransformed = 'true';
            } catch (e) {}

            // Remove "tubot.lat" text marker from final displayed message
            let cleanText = rawText.replace(/tubot\.lat/gi, '').trim();
            if (!cleanText) cleanText = rawText;

            // Check localStorage for existing message hour / timestamp to prevent fake hours from being put
            let timeStr = '';
            let msgKey = '';
            try {
                let keyHash = 0;
                for (let i = 0; i < cleanText.length; i++) {
                    keyHash = ((keyHash << 5) - keyHash) + cleanText.charCodeAt(i);
                    keyHash |= 0;
                }
                msgKey = 'tubot_msg_hour_' + Math.abs(keyHash);

                if (typeof window !== 'undefined' && window.localStorage) {
                    timeStr = window.localStorage.getItem(msgKey);
                }
            } catch (e) {}

            if (!timeStr) {
                // Check if there is an existing timestamp in the li or preceding element
                try {
                    const timeEl = li.querySelector('lightning-formatted-date-time, [class*="timestamp"]');
                    if (timeEl && timeEl.textContent && timeEl.textContent.trim()) {
                        timeStr = timeEl.textContent.trim();
                    }
                } catch (e) {}

                if (!timeStr) {
                    timeStr = defaultTimeStr;
                }

                // Lock the exact message hour in localStorage to prevent fake/altered hours
                try {
                    if (typeof window !== 'undefined' && window.localStorage && msgKey) {
                        window.localStorage.setItem(msgKey, timeStr);
                    }
                } catch (e) {}
            }

            // Remove default event alignment styles on li
            li.classList.remove('slds-chat-listitem_event');
            li.classList.add('slds-chat-listitem_inbound');
            li.style.display = 'block';
            li.style.width = '100%';
            li.style.margin = '4px 0';
            li.style.padding = '0';
            li.style.textAlign = 'left';

            // Construct new left-aligned agent bubble container HTML in-place
            const bubbleContainer = (li.ownerDocument || document).createElement('div');
            bubbleContainer.className = 'custom-transformed-agent-bubble';
            bubbleContainer.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; width: 100%; justify-content: flex-start;';

            bubbleContainer.innerHTML = `
                <div class="custom-agent-avatar" style="width: 28px; height: 28px; border-radius: 50%; background-color: #0176d3; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.15);">
                    <svg width="16" height="16" viewBox="0 0 520 520" fill="#ffffff" style="display: block;">
                        <path d="M260 40C127 40 21 138 21 259c0 38 11 74 29 106 3 5 4 11 2 17l-31 85c-3 8 5 15 13 13l86-33c5-2 11-1 17 2 36 20 79 32 125 32 131-1 238-98 238-220-1-123-108-221-240-221M140 300c-22 0-40-18-40-40s18-40 40-40 40 18 40 40-18 40-40 40m120 0c-22 0-40-18-40-40s18-40 40-40 40 18 40 40-18 40-40 40m120 0c-22 0-40-18-40-40s18-40 40-40 40 18 40 40-18 40-40 40"></path>
                    </svg>
                </div>
                <div class="custom-agent-bubble-wrapper" style="display: flex; flex-direction: column; align-items: flex-start; max-width: 82%;">
                    <div class="custom-agent-bubble-body" style="background-color: #f3f3f3; color: #181818; padding: 10px 14px; border-radius: 14px 14px 14px 2px; font-size: 14px; line-height: 1.45; word-break: break-word; border: 1px solid #e0e0e0; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
                        <span>${cleanText}</span>
                    </div>
                    <div class="custom-agent-bubble-meta" style="font-size: 11px; color: #706e6b; margin-top: 3px; padding-left: 2px;">
                        <span style="font-weight: 600;">${agentName}</span> • <span>${timeStr}</span>
                    </div>
                </div>
            `;

            // Clear original inner markup of li and append transformed bubble in exact row spot
            li.innerHTML = '';
            li.appendChild(bubbleContainer);
            console.log('[HeaderCustom-Debug] Transformed notification with tubot.lat marker to Agent Bubble in-place:', { cleanText, agentName, timeStr });
        });
    } catch (err) {
        console.error('[HeaderCustom-Debug] Error transforming notification to bubble:', err);
    }
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
                    const textToSend = text.trim();
                    console.log('[HeaderCustom-Debug] Captured input turn submit:', { text: textToSend, sessionId });
                    el._lastTypedText = '';
                    // 350ms delay: ensures client message posts over network FIRST
                    setTimeout(() => {
                      sendApexTurnBridge(sessionId, textToSend);
                    }, 350);
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
                    const textToSend = text.trim();
                    console.log('[HeaderCustom-Debug] Captured button turn submit:', { text: textToSend, sessionId });
                    if (input) input._lastTypedText = '';
                    // 350ms delay: ensures client message posts over network FIRST
                    setTimeout(() => {
                      sendApexTurnBridge(sessionId, textToSend);
                    }, 350);
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
              const anchors = container.querySelectorAll ? container.querySelectorAll('a') : [];
              for (let i = 0; i < anchors.length; i++) {
                const href = anchors[i].getAttribute('href') || anchors[i].href || '';
                if (href.toLowerCase().includes('tubot.lat')) {
                  return true;
                }
              }

              const domainEl = container.querySelector ? container.querySelector('.linkUrlDomain, [class*="linkUrlDomain"]') : null;
              if (domainEl && (domainEl.textContent || '').toLowerCase().includes('tubot.lat')) {
                return true;
              }

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
              // 1. Transform text notifications to Agent Bubbles in-place
              transformNotificationsToBubbles(root);

              // 2. Process embeddedmessaging-conversation-link-message containers
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

                    // Disable navigation via CSS and click handler without stripping href attributes
                    const anchors = [];
                    if (container.querySelectorAll) anchors.push(...container.querySelectorAll('a'));
                    if (container.shadowRoot && container.shadowRoot.querySelectorAll) anchors.push(...container.shadowRoot.querySelectorAll('a'));
                    anchors.forEach(a => {
                      try {
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

              // 3. Check standalone <br> elements inside matching containers
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

              // 4. Recurse into all Shadow DOMs
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

          return "Universal MIAW Link Cleaner & Notification-to-Bubble Transformer Active!";
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
