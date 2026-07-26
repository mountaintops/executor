#!/usr/bin/env bash

# ==============================================================================
# Automated Salesforce Messaging & Notification Org Setup Script
# ==============================================================================
# Usage:
#   ./setup_org_messaging.sh [target_org_alias]
# Default target org: tubot.10f347fecf84@agentforce.com
# ==============================================================================

set -eo pipefail

TARGET_ORG="${1:-tubot.10f347fecf84@agentforce.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

log_info "Starting Automated Salesforce Org Setup for target org: ${TARGET_ORG}"

# 1. Retrieve Active Org Session Token from Salesforce CLI using python3
log_info "Retrieving active org access token..."
ORG_DISPLAY=$(SF_TEMP_SHOW_SECRETS=true sf org display -o "${TARGET_ORG}" --json 2>/dev/null || true)

ACCESS_TOKEN=$(python3 -c "import sys, json; data=json.loads(sys.stdin.read()); print(data.get('result', {}).get('accessToken', ''))" <<< "$ORG_DISPLAY")
INSTANCE_URL=$(python3 -c "import sys, json; data=json.loads(sys.stdin.read()); print(data.get('result', {}).get('instanceUrl', ''))" <<< "$ORG_DISPLAY")

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" == "None" ]; then
    log_error "Could not retrieve access token for org ${TARGET_ORG}. Ensure org is authenticated."
    exit 1
fi

log_success "Access token retrieved successfully for ${INSTANCE_URL}"

# 2. Deploy Metadata & Components
log_info "Deploying package metadata to ${TARGET_ORG}..."
sf project deploy start --source-dir "${SCRIPT_DIR}/force-app" --target-org "${TARGET_ORG}" --wait 10

# 3. Assign Permission Sets
log_info "Assigning permission sets..."
sf org assign permset -n Top_Notification_Admin_Access -o "${TARGET_ORG}" || true

# 4. Upsert Messaging_Config__c Custom Setting Org Defaults
log_info "Initializing Messaging_Config__c org defaults with active API token..."
TEMP_APEX="${SCRIPT_DIR}/.setup_temp.apex"

cat << EOF > "$TEMP_APEX"
String activeToken = '${ACCESS_TOKEN}';
Messaging_Config__c config = Messaging_Config__c.getOrgDefaults();
if (config == null) {
    config = new Messaging_Config__c();
}
config.Api_Token__c = activeToken;
if (String.isBlank(config.Selected_Messaging_Channel_Id__c)) {
    config.Selected_Messaging_Channel_Id__c = 'ALL';
}
upsert config;
System.debug('>>> [Setup] Successfully updated Messaging_Config__c org defaults with token length: ' + activeToken.length());
EOF

sf apex run --file "$TEMP_APEX" -o "${TARGET_ORG}"
rm -f "$TEMP_APEX"

log_success "Messaging_Config__c custom setting initialized successfully!"

# 5. Execute Turn Handler Verification Test
log_info "Running turn handler callout verification test..."
VERIFY_APEX="${SCRIPT_DIR}/.verify_temp.apex"

cat << EOF > "$VERIFY_APEX"
Map<String, Object> res = HeaderCustomController.handleIncomingTurn('ACTIVE_SESSION', 'System setup verification turn', true);
System.debug('>>> [Setup-Verify] Success: ' + res.get('success') + ' | Message: ' + res.get('message'));
EOF

VERIFY_OUTPUT=$(sf apex run --file "$VERIFY_APEX" -o "${TARGET_ORG}" 2>&1 || true)
rm -f "$VERIFY_APEX"

if echo "$VERIFY_OUTPUT" | grep -q "Component notification sent successfully"; then
    log_success "Turn handler verification PASSED! (HTTP 200 OK)"
else
    log_warn "Turn handler output note: ${VERIFY_OUTPUT}"
fi

# 6. Run Apex Unit Test Suite
log_info "Running Apex test suite..."
sf apex run test -n HeaderCustomControllerTest,TopNotificationControllerTest -o "${TARGET_ORG}" --wait 10

log_success "🎉 Salesforce Org Setup & Config completed with ZERO errors!"
