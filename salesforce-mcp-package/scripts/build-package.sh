#!/usr/bin/env bash
set -e

# ==============================================================================
# Salesforce 2GP Unlocked Package Builder
# ==============================================================================

DEV_HUB_ALIAS=${1:-"DevHub"}
PACKAGE_NAME="Executor-MCP-Connector"

echo "=== 1. Checking Salesforce CLI ==="
if ! command -v sf &> /dev/null; then
    echo "Error: Salesforce CLI ('sf') is not installed."
    echo "Install it via: npm install -g @salesforce/cli"
    exit 1
fi

echo "=== 2. Authenticating / Verifying DevHub ($DEV_HUB_ALIAS) ==="
sf org display --target-org "$DEV_HUB_ALIAS" || {
    echo "Dev Hub '$DEV_HUB_ALIAS' not found. Please log in using:"
    echo "sf org login web --set-default-dev-hub --alias $DEV_HUB_ALIAS"
    exit 1
}

echo "=== 3. Ensuring Unlocked Package Registration ==="
if ! sf package list --target-dev-hub "$DEV_HUB_ALIAS" | grep -q "$PACKAGE_NAME"; then
    echo "Registering new Unlocked Package: $PACKAGE_NAME"
    sf package create \
        --name "$PACKAGE_NAME" \
        --package-type Unlocked \
        --path force-app \
        --target-dev-hub "$DEV_HUB_ALIAS"
else
    echo "Package '$PACKAGE_NAME' is already registered in Dev Hub."
fi

echo "=== 4. Creating 2GP Unlocked Package Version (Bypassing Installation Key) ==="
VERSION_OUTPUT=$(sf package version create \
    --package "$PACKAGE_NAME" \
    --installation-key-bypass \
    --target-dev-hub "$DEV_HUB_ALIAS" \
    --wait 15 \
    --json)

echo "$VERSION_OUTPUT"

PACKAGE_VERSION_ID=$(echo "$VERSION_OUTPUT" | grep -o '"SubscriberPackageVersionId": "[^"]*' | cut -d'"' -f4)

if [ -n "$PACKAGE_VERSION_ID" ]; then
    echo ""
    echo "=========================================================================="
    echo " SUCCESS! Package Version Created: $PACKAGE_VERSION_ID"
    echo " Client Installation URL:"
    echo " https://login.salesforce.com/packaging/installPackage.apexp?p0=$PACKAGE_VERSION_ID"
    echo "=========================================================================="
else
    echo "Package version creation completed. Please inspect the JSON output above for SubscriberPackageVersionId."
fi
