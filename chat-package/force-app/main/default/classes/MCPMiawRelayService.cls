/**
 * @description Apex REST resource for MIAW Custom Messaging Proxy (bt-proxy) handshakes, token issuance,
 * conversation instantiation, and message relaying between Cloudflare Workers and Salesforce.
 */
@RestResource(urlMapping='/mcp/v1/miaw/*')
global with sharing class MCPMiawRelayService {

    public class RelayRequest {
        @InvocableVariable(label='User ID' required=true)
        public String userId;
        
        @InvocableVariable(label='Sender Type (user/agent)' required=false)
        public String sender;
        
        @InvocableVariable(label='Message Content' required=true)
        public String content;
    }

    public class RelayResult {
        @InvocableVariable(label='Success')
        public Boolean success;
        
        @InvocableVariable(label='Message ID')
        public String messageId;
    }

    @HttpPost
    global static void handleMiawPost() {
        RestRequest req = RestContext.request;
        RestResponse res = RestContext.response;
        if (res == null) {
            res = new RestResponse();
            RestContext.response = res;
        }
        res.addHeader('Content-Type', 'application/json');

        String uri = req.requestURI != null ? req.requestURI.toLowerCase() : '';
        String requestBodyStr = req.requestBody != null ? req.requestBody.toString() : '{}';
        Map<String, Object> bodyMap = (Map<String, Object>) JSON.deserializeUntyped(requestBodyStr);

        if (uri.endsWith('/token') || uri.contains('/token')) {
            String token = 'miaw_jwt_' + String.valueOf(Crypto.getRandomLong());
            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
                'accessToken' => token,
                'tokenType' => 'Bearer',
                'expiresInSec' => 3600,
                'status' => 'success'
            }));
            return;
        }

        if (uri.endsWith('/conversation') || uri.contains('/conversation')) {
            String userId = bodyMap.containsKey('userId') ? (String) bodyMap.get('userId') : 'user_default';
            String conversationId = 'conv_' + String.valueOf(Crypto.getRandomLong()).substring(0, 10);
            
            Id createdSessionId = createRealMessagingSession(userId, 'New Enhanced Chat session initiated via bt-proxy');

            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
                'conversationId' => conversationId,
                'userId' => userId,
                'sessionId' => createdSessionId,
                'status' => 'ACTIVE',
                'routingType' => 'OmniChannel',
                'createdDate' => String.valueOf(DateTime.now())
            }));
            return;
        }

        if (uri.endsWith('/message') || uri.contains('/message')) {
            String conversationId = bodyMap.containsKey('conversationId') ? (String) bodyMap.get('conversationId') : 'conv_default';
            String messageText = bodyMap.containsKey('messageText') ? (String) bodyMap.get('messageText') : '';
            if (String.isBlank(messageText) && bodyMap.containsKey('message')) {
                messageText = (String) bodyMap.get('message');
            }
            String userId = bodyMap.containsKey('userId') ? (String) bodyMap.get('userId') : 'user_default';
            if (bodyMap.containsKey('external_user_id')) {
                userId = (String) bodyMap.get('external_user_id');
            }

            Id createdSessionId = createRealMessagingSession(userId, messageText);

            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
                'status' => 'success',
                'messageId' => 'msg_' + String.valueOf(Crypto.getRandomLong()),
                'conversationId' => conversationId,
                'sessionId' => createdSessionId,
                'userText' => messageText,
                'timestamp' => String.valueOf(DateTime.now())
            }));
            return;
        }

        if (uri.endsWith('/outbound') || uri.contains('/outbound')) {
            String userId = bodyMap.containsKey('userId') ? (String) bodyMap.get('userId') : 'user_default';
            String sender = bodyMap.containsKey('sender') ? (String) bodyMap.get('sender') : 'agent';
            String messageText = bodyMap.containsKey('content') ? (String) bodyMap.get('content') : '';

            res.statusCode = 200;
            res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
                'status' => 'success',
                'relayed' => true,
                'userId' => userId,
                'sender' => sender
            }));
            return;
        }

        res.statusCode = 404;
        res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{ 'error' => 'Unknown MIAW relay endpoint' }));
    }

    private static Id createRealMessagingSession(String userId, String messageText) {
        try {
            // Target WebChat (EmbeddedMessaging) channel first for Enhanced Chat
            List<MessagingChannel> channels = [SELECT Id, MessageType FROM MessagingChannel WHERE DeveloperName = 'WebChat' OR DeveloperName = 'Custom_Text_Channel_1784685690612' LIMIT 1];
            if (channels.isEmpty()) return null;
            MessagingChannel channel = channels[0];

            String targetName = 'Enhanced MIAW User ' + userId;
            List<MessagingEndUser> endUsers = [SELECT Id FROM MessagingEndUser WHERE MessagingChannelId = :channel.Id AND Name = :targetName LIMIT 1];
            Id endUserId;
            if (endUsers.isEmpty()) {
                MessagingEndUser eu = new MessagingEndUser();
                eu.Name = targetName;
                eu.MessagingChannelId = channel.Id;
                eu.MessageType = channel.MessageType != null ? channel.MessageType : 'EmbeddedMessaging';
                eu.MessagingPlatformKey = 'key_enh_' + userId;
                insert eu;
                endUserId = eu.Id;
            } else {
                endUserId = endUsers[0].Id;
            }

            // Create Case with exact message text in Description
            Case c = new Case();
            c.Subject = 'Enhanced MIAW Message from ' + userId;
            c.Description = messageText;
            c.Origin = 'Web';
            c.Status = 'New';
            insert c;

            MessagingSession ms = new MessagingSession();
            ms.MessagingChannelId = channel.Id;
            ms.MessagingEndUserId = endUserId;
            ms.Status = 'Active';
            ms.CaseId = c.Id;

            try {
                insert ms;
            } catch (DmlException dmlEx) {
                if (dmlEx.getMessage().contains('Conversation Identifier field required')) {
                    // Fallback to standard Text channel if EmbeddedMessaging requires system-generated ConversationId
                    List<MessagingChannel> textChannels = [SELECT Id FROM MessagingChannel WHERE DeveloperName = 'Custom_Text_Channel_1784685690612' LIMIT 1];
                    if (!textChannels.isEmpty()) {
                        ms.MessagingChannelId = textChannels[0].Id;
                        insert ms;
                    }
                } else {
                    throw dmlEx;
                }
            }

            return ms.Id;
        } catch (Exception ex) {
            System.debug(LoggingLevel.ERROR, 'Failed to create real MessagingSession: ' + ex.getMessage());
            return null;
        }
    }

    @InvocableMethod(label='Relay Outbound MIAW Message to Worker' description='Relays outbound Salesforce agent responses to Cloudflare Worker proxy')
    public static List<RelayResult> relayOutboundInvocable(List<RelayRequest> requests) {
        List<RelayResult> results = new List<RelayResult>();
        if (requests == null || requests.isEmpty()) return results;

        for (RelayRequest req : requests) {
            RelayResult res = new RelayResult();
            res.messageId = 'msg_inv_' + String.valueOf(Crypto.getRandomLong());
            res.success = true;
            results.add(res);

            relayOutboundMessageToWorkerAsync(req.userId, req.sender != null ? req.sender : 'agent', req.content);
        }
        return results;
    }

    @future(callout=true)
    public static void relayOutboundMessageToWorkerAsync(String userId, String sender, String content) {
        try {
            String targetWorkerUrl = 'https://executor-cloudflare.emalteaproductions.workers.dev/api/bt/outbound';
            HttpRequest req = new HttpRequest();
            req.setEndpoint(targetWorkerUrl);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            
            Map<String, Object> payload = new Map<String, Object>{
                'userId' => userId,
                'sender' => sender,
                'content' => content,
                'source' => 'Salesforce_Apex_Relay'
            };
            req.setBody(JSON.serialize(payload));

            Http http = new Http();
            HttpResponse res = http.send(req);
            System.debug(LoggingLevel.INFO, 'Relay outbound status: ' + res.getStatusCode() + ' | body: ' + res.getBody());
        } catch (Exception ex) {
            System.debug(LoggingLevel.ERROR, 'Outbound callout relay error: ' + ex.getMessage());
        }
    }
}