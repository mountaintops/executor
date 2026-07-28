#!/usr/bin/env bash

# ==============================================================================
# DEPRECATED SCRIPT: setup_org_messaging.sh
# ==============================================================================
# NOTICE: This script is now DEPRECATED in favor of native Salesforce Metadata API
# and PackagePostInstallHandler Apex class.
#
# To deploy and setup the org automatically, simply run standard Salesforce CLI:
#   sf project deploy start --target-org [target_org_alias]
# ==============================================================================

set -eo pipefail

TARGET_ORG="${1:-tubot.10f347fecf84@agentforce.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[DEPRECATED] Running standard Salesforce Metadata deployment to: ${TARGET_ORG}"
sf project deploy start --source-dir "${SCRIPT_DIR}/force-app" --target-org "${TARGET_ORG}" --wait 10
echo "[SUCCESS] Metadata deployed successfully! Post-install handler & Apex self-initialization completed automatically."
