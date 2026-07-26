#!/usr/bin/env bash

# ==============================================================================
# Salesforce Package & Source Deployment Automation Script
# ==============================================================================
# Usage:
#   ./deploy_package.sh [options]
#
# Options:
#   -o, --target-org ALIAS    Target org username/alias (default: tubot.10f347fecf84@agentforce.com)
#   -m, --mode MODE           Deployment mode: 'source' (default) or 'package'
#   -l, --test-level LEVEL    Apex test level: NoTestRun (default), RunLocalTests, RunAllTestsInOrg, RunSpecifiedTests
#   -t, --tests TESTS         Comma-separated list of Apex test classes (required if test-level is RunSpecifiedTests)
#   -c, --check-only          Perform dry-run deployment validation without saving changes
#   -s, --source-dir DIR      Specific source directory to deploy (default: force-app)
#   -w, --wait MINUTES        Wait time in minutes for deployment/package commands (default: 10)
#   -p, --promote             Auto-promote created package version (only applicable in 'package' mode)
#   -h, --help                Show this help message
# ==============================================================================

set -eo pipefail

# Default Configurations
TARGET_ORG="tubot.10f347fecf84@agentforce.com"
MODE="source"
TEST_LEVEL="NoTestRun"
TEST_CLASSES=""
CHECK_ONLY=false
SOURCE_DIR="force-app"
WAIT_TIME=10
PROMOTE=false

# Color Output Formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

show_help() {
    cat << EOF
Salesforce Package & Source Deployment Automation Script

Usage:
  ./deploy_package.sh [options]

Options:
  -o, --target-org ALIAS    Target org username/alias (default: tubot.10f347fecf84@agentforce.com)
  -m, --mode MODE           Deployment mode: 'source' (default) or 'package'
  -l, --test-level LEVEL    Apex test level: NoTestRun (default), RunLocalTests, RunAllTestsInOrg, RunSpecifiedTests
  -t, --tests TESTS         Comma-separated Apex test class names
  -c, --check-only          Dry-run validation mode (no changes committed)
  -s, --source-dir DIR      Source directory (default: force-app)
  -w, --wait MINUTES        Wait timeout in minutes (default: 10)
  -p, --promote             Promote package version (package mode only)
  -h, --help                Show this help message
EOF
}

# Parse Command Line Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--target-org)
            TARGET_ORG="$2"
            shift 2
            ;;
        -m|--mode)
            MODE="$2"
            shift 2
            ;;
        -l|--test-level)
            TEST_LEVEL="$2"
            shift 2
            ;;
        -t|--tests)
            TEST_CLASSES="$2"
            shift 2
            ;;
        -c|--check-only)
            CHECK_ONLY=true
            shift
            ;;
        -s|--source-dir)
            SOURCE_DIR="$2"
            shift 2
            ;;
        -w|--wait)
            WAIT_TIME="$2"
            shift 2
            ;;
        -p|--promote)
            PROMOTE=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Ensure Salesforce CLI ('sf') is Installed
if ! command -v sf &> /dev/null; then
    log_error "Salesforce CLI ('sf') is not installed or not in PATH."
    exit 1
fi

log_info "Starting Salesforce Deployment Process..."
log_info "Target Org: ${TARGET_ORG}"
log_info "Mode: ${MODE}"
log_info "Source Directory: ${SOURCE_DIR}"

if [[ "$MODE" == "source" ]]; then
    # Construct Source Deploy Command
    DEPLOY_CMD="sf project deploy start --source-dir ${SOURCE_DIR} --target-org ${TARGET_ORG} --wait ${WAIT_TIME}"

    if [ "$CHECK_ONLY" = true ]; then
        log_info "Running in CHECK-ONLY (Dry Run) validation mode..."
        DEPLOY_CMD="${DEPLOY_CMD} --dry-run"
    fi

    if [ "$TEST_LEVEL" != "NoTestRun" ]; then
        DEPLOY_CMD="${DEPLOY_CMD} --test-level ${TEST_LEVEL}"
        if [[ "$TEST_LEVEL" == "RunSpecifiedTests" ]]; then
            if [ -z "$TEST_CLASSES" ]; then
                log_error "Test level is set to RunSpecifiedTests but no test classes were specified (-t / --tests)."
                exit 1
            fi
            DEPLOY_CMD="${DEPLOY_CMD} --tests ${TEST_CLASSES}"
        fi
    fi

    log_info "Executing: ${DEPLOY_CMD}"
    eval "$DEPLOY_CMD"

    log_success "Source deployment to ${TARGET_ORG} completed successfully!"

    # Run Apex Tests if requested post-deployment
    if [[ "$TEST_LEVEL" != "NoTestRun" && "$CHECK_ONLY" = false ]]; then
        log_info "Executing Apex tests on ${TARGET_ORG}..."
        TEST_CMD="sf apex run test --target-org ${TARGET_ORG} --wait ${WAIT_TIME}"
        if [ -n "$TEST_CLASSES" ]; then
            # Split comma separated classes into flag arguments
            TEST_ARGS=""
            IFS=',' read -ra ADDR <<< "$TEST_CLASSES"
            for t in "${ADDR[@]}"; do
                TEST_ARGS="${TEST_ARGS} -n ${t}"
            done
            TEST_CMD="sf apex run test ${TEST_ARGS} --target-org ${TARGET_ORG} --wait ${WAIT_TIME}"
        fi
        log_info "Running: ${TEST_CMD}"
        eval "$TEST_CMD"
        log_success "Apex test execution completed!"
    fi

elif [[ "$MODE" == "package" ]]; then
    log_info "Creating 2nd Generation Package Version..."
    
    CREATE_CMD="sf package version create --package SalesforceHostedMCPAutoRegister --path ${SOURCE_DIR} --target-dev-hub ${TARGET_ORG} --wait ${WAIT_TIME} --code-coverage --json"
    
    log_info "Executing: ${CREATE_CMD}"
    BUILD_OUTPUT=$(eval "$CREATE_CMD")
    
    # Extract Package Version ID (04t...)
    PACKAGE_VERSION_ID=$(echo "$BUILD_OUTPUT" | jq -r '.result.SubscriberPackageVersionId // empty')

    if [ -z "$PACKAGE_VERSION_ID" ]; then
        log_error "Failed to retrieve SubscriberPackageVersionId from package build output."
        echo "$BUILD_OUTPUT"
        exit 1
    fi

    log_success "Created Package Version ID: ${PACKAGE_VERSION_ID}"

    if [ "$PROMOTE" = true ]; then
        log_info "Promoting Package Version ${PACKAGE_VERSION_ID}..."
        sf package version promote --package "${PACKAGE_VERSION_ID}" --target-dev-hub "${TARGET_ORG}" --no-prompt
        log_success "Package version ${PACKAGE_VERSION_ID} promoted to released status!"
    fi

    log_info "Installing Package Version ${PACKAGE_VERSION_ID} into target org ${TARGET_ORG}..."
    sf package install --package "${PACKAGE_VERSION_ID}" --target-org "${TARGET_ORG}" --wait "${WAIT_TIME}" --no-prompt
    log_success "Package version ${PACKAGE_VERSION_ID} installed successfully in ${TARGET_ORG}!"

else
    log_error "Invalid mode: ${MODE}. Must be 'source' or 'package'."
    exit 1
fi

log_success "All Salesforce deployment tasks completed cleanly! 🎉"
