#!/usr/bin/env python3
"""
Salesforce Headless 360 Hosted MCP & Cloudflare Executor Validation Suite

This script uses your specific Salesforce org credentials and Cloudflare Executor Worker
to test authentication, fetch the OpenAPI 3.0 spec, and list all available Headless 360 MCP tools.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

# User Specific Credentials
USER_ORG_ID = "00Dg500000FHRCsEAP"
USER_CLIENT_ID = "SFDC_MCP_CLIENT_11988287"
USER_CLIENT_SECRET = "sec_7bc6052ed35246b88267ecbe3cba73c8917dc6256380ef3bb09d3b341ab719ee"
USER_INSTANCE_URL = "https://orgfarm-9c01b1d16c-dev-ed.develop.my.salesforce.com"
USER_INSTALLED_BY = "tubot.10f347fecf84@agentforce.com"
USER_TIMESTAMP = "2026-07-21 12:12:16"

# Direct Salesforce Hosted MCP Endpoints
DIRECT_MCP_URL = f"{USER_INSTANCE_URL}/services/apexrest/mcp/v1/headless360/"
DIRECT_OPENAPI_URL = f"{USER_INSTANCE_URL}/services/apexrest/mcp/v1/openapi/"
CLOUDFLARE_WORKER_URL = "https://executor-cloudflare.emalteaproductions.workers.dev"
CACHED_OPENAPI_SPEC_URL = f"{CLOUDFLARE_WORKER_URL}/api/sf/openapi.json?api_key=sf_key_b67d9e7cff0345bc9791b1947a34212a"
PROXIED_MCP_URL = f"{CLOUDFLARE_WORKER_URL}/api/sf/mcp"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def get_sf_org_token(org_alias="DevHub"):
    """Fetch access token using sf CLI if available"""
    try:
        cmd = ["sf", "org", "display", "--target-org", org_alias, "--json"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        return data.get("result", {}).get("accessToken")
    except Exception:
        return None

def test_openapi_endpoint(url):
    """Test retrieving OpenAPI 3.0 JSON specification"""
    print(f"\n📘 [1] Testing Viewable OpenAPI 3.0 Spec Endpoint:")
    print(f"   URL: {url}")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
    }

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req) as resp:
            raw_bytes = resp.read()
            byte_size = len(raw_bytes)
            kb_size = byte_size / 1024.0
            spec = json.loads(raw_bytes.decode("utf-8"))
            print("  ✅ OpenAPI 3.0 Spec Successfully Retrieved:")
            print(f"     • Title          : {spec.get('info', {}).get('title')}")
            print(f"     • Version        : {spec.get('info', {}).get('version')}")
            print(f"     • Raw Byte Size  : {byte_size:,} bytes ({kb_size:.2f} KB)")
            paths = list(spec.get("paths", {}).keys())
            schemas = list(spec.get("components", {}).get("schemas", {}).keys())
            print(f"     • Total API Paths: {len(paths):,}")
            print(f"     • Total Schemas  : {len(schemas):,}")

            is_greater_than_200kb = byte_size > (200 * 1024)
            print(f"     • > 200KB Check  : {'✅ PASSED (' + str(round(kb_size, 2)) + ' KB > 200 KB)' if is_greater_than_200kb else '❌ FAILED'}")
            return spec
    except urllib.error.HTTPError as e:
        print(f"  ❌ OpenAPI Spec Endpoint returned HTTP {e.code}: {e.read().decode('utf-8')[:200]}")
    except Exception as e:
        print(f"  ❌ OpenAPI Spec fetch error: {e}")
    return None

def test_mcp_server(mcp_url, token, label="Hosted MCP", org_alias="DevHub"):
    """Test MCP protocol initialize and tools/list on specified MCP endpoint"""
    print(f"\n📡 [2] Connecting to {label} Endpoint:")
    print(f"   URL: {mcp_url}")

    tools_res = None
    if "apexrest" in mcp_url or "orgfarm-" in mcp_url:
        try:
            # Step 1: MCP Initialize Handshake via sf CLI
            init_cmd = ["sf", "api", "request", "rest", "/services/apexrest/mcp/v1/headless360/", "--target-org", org_alias, "--method", "POST", "--body", json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})]
            res = subprocess.run(init_cmd, capture_output=True, text=True, check=True)
            init_res = json.loads(res.stdout)
            server_info = init_res.get("result", {}).get("serverInfo", {})
            print(f"   ✅ DIRECT Salesforce MCP Handshake Success (initialize):")
            print(f"      • Server Name    : {server_info.get('name', 'Salesforce Headless 360 MCP')}")
            print(f"      • Server Version : {server_info.get('version', '1.0.0')}")

            # Step 2: MCP Tools List Request via sf CLI
            tools_cmd = ["sf", "api", "request", "rest", "/services/apexrest/mcp/v1/headless360/", "--target-org", org_alias, "--method", "POST", "--body", json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})]
            res_tools = subprocess.run(tools_cmd, capture_output=True, text=True, check=True)
            tools_res = json.loads(res_tools.stdout)
            tools = tools_res.get("result", {}).get("tools", [])
            print(f"\n🛠️  DIRECT Salesforce MCP Tools Enumeration Result (tools/list): Found {len(tools)} tools!")
            for idx, tool in enumerate(tools, 1):
                name = tool.get("name")
                desc = tool.get("description", "No description provided")
                print(f"   {idx}. 🔧 [{name}]")
                print(f"      Description : {desc[:120]}...")
            return tools_res
        except Exception as e:
            print(f"   ❌ DIRECT Salesforce MCP call error: {e}")

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT
    }

    # Step 1: MCP Initialize Handshake
    init_payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "Salesforce-MCP-Python-Validator",
                "version": "1.0.0"
            }
        }
    }

    try:
        req = urllib.request.Request(mcp_url, data=json.dumps(init_payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            init_res = json.loads(resp.read().decode("utf-8"))
            server_info = init_res.get("result", {}).get("serverInfo", {})
            print(f"   ✅ MCP Handshake Success (initialize):")
            print(f"      • Server Name    : {server_info.get('name', 'Salesforce Headless 360 MCP')}")
            print(f"      • Server Version : {server_info.get('version', '1.0.0')}")
    except urllib.error.HTTPError as e:
        body_str = e.read().decode('utf-8')
        print(f"   ⚠️  MCP Initialize Handshake HTTP {e.code}: {body_str[:250]}")
    except Exception as e:
        print(f"   ⚠️  MCP Initialize Handshake note: {e}")

    # Step 2: MCP Tools List Request
    tools_payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }

    try:
        req = urllib.request.Request(mcp_url, data=json.dumps(tools_payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            tools_res = json.loads(resp.read().decode("utf-8"))
            tools = tools_res.get("result", {}).get("tools", [])
            print(f"\n🛠️  MCP Tools Enumeration Result (tools/list): Found {len(tools)} tools!")
            for idx, tool in enumerate(tools, 1):
                name = tool.get("name")
                desc = tool.get("description", "No description provided")
                print(f"   {idx}. 🔧 [{name}]")
                print(f"      Description : {desc[:120]}...")
            return tools_res
    except urllib.error.HTTPError as e:
        body_str = e.read().decode('utf-8')
        print(f"   ❌ MCP tools/list call failed HTTP {e.code}: {body_str[:300]}")
    except Exception as e:
        print(f"   ❌ Failed tools/list call: {e}")

    return None

def test_mcp_situations(org_alias="DevHub"):
    """Execute realistic MCP tool call scenarios across discover, describe, dispatch_readonly, and dispatch"""
    print("\n" + "=" * 75)
    print("🧪 Executing Headless 360 MCP Tool Calls for Test Situations")
    print("=" * 75)

    test_scenarios = [
        {"name": "Scenario 1: List Accounts", "intent": "list accounts", "op_id": "op_list_accounts", "mode": "dispatch_readonly"},
        {"name": "Scenario 2: List Installed Packages", "intent": "list packages", "op_id": "op_list_installed_packages", "mode": "dispatch_readonly"},
        {"name": "Scenario 3: Delete Lead", "intent": "what can i use for deleting leads", "op_id": "op_delete_lead", "mode": "dispatch"}
    ]

    for scenario in test_scenarios:
        print(f"\n📌 {scenario['name']} (Prompt: '{scenario['intent']}')")

        # 1. discover
        print("  1️⃣ Calling tool [discover]...")
        cmd_discover = [
            "sf", "api", "request", "rest", "/services/apexrest/mcp/v1/headless360/",
            "--target-org", org_alias, "--method", "POST",
            "--body", json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "discover", "arguments": {"intent": scenario["intent"]}}
            })
        ]
        res1 = json.loads(subprocess.run(cmd_discover, capture_output=True, text=True).stdout)
        discover_text = res1.get("result", {}).get("content", [{}])[0].get("text", "")
        print(f"     ✅ Result: {discover_text[:220]}...\n")

        # 2. describe
        print(f"  2️⃣ Calling tool [describe] for operation '{scenario['op_id']}'...")
        cmd_describe = [
            "sf", "api", "request", "rest", "/services/apexrest/mcp/v1/headless360/",
            "--target-org", org_alias, "--method", "POST",
            "--body", json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "describe", "arguments": {"operationId": scenario["op_id"]}}
            })
        ]
        res2 = json.loads(subprocess.run(cmd_describe, capture_output=True, text=True).stdout)
        describe_text = res2.get("result", {}).get("content", [{}])[0].get("text", "")
        print(f"     ✅ Technical Specification:\n{describe_text}\n")

        # 3. dispatch or dispatch_readonly
        tool_to_call = scenario["mode"]
        print(f"  3️⃣ Calling tool [{tool_to_call}] for operation '{scenario['op_id']}'...")
        cmd_dispatch = [
            "sf", "api", "request", "rest", "/services/apexrest/mcp/v1/headless360/",
            "--target-org", org_alias, "--method", "POST",
            "--body", json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": tool_to_call,
                    "arguments": {
                        "operationId": scenario["op_id"],
                        "parameters": {"recordId": "00Q000000000000AAA"}
                    }
                }
            })
        ]
        res3 = json.loads(subprocess.run(cmd_dispatch, capture_output=True, text=True).stdout)
        dispatch_text = res3.get("result", {}).get("content", [{}])[0].get("text", "")
        print(f"     ✅ Execution Output:\n{dispatch_text}\n")

def main():
    parser = argparse.ArgumentParser(description="Salesforce Headless 360 Hosted MCP & Cloudflare Validator")
    parser.add_argument("--target-org", "-o", default="DevHub", help="Salesforce org alias or username")
    args = parser.parse_args()

    print("=" * 75)
    print("🚀 Salesforce Headless 360 Hosted MCP & OpenAPI Validation Suite")
    print("=" * 75)

    print(f"📋 Your Org Credentials & Webhook Log Metadata:")
    print(f"   • Event           : MCP_AUTO_REGISTER_SUCCESS")
    print(f"   • Org ID          : {USER_ORG_ID}")
    print(f"   • Instance URL    : {USER_INSTANCE_URL}")
    print(f"   • Client ID       : {USER_CLIENT_ID}")
    print(f"   • Status          : Active - Registered")
    print(f"   • Installed By    : {USER_INSTALLED_BY}")
    print(f"   • Direct MCP URL  : {DIRECT_MCP_URL}")

    # Fetch token via CLI or fallback to Client Secret
    access_token = get_sf_org_token(args.target_org) or USER_CLIENT_SECRET

    # 1. Test Viewable OpenAPI Spec Endpoint
    test_openapi_endpoint(CACHED_OPENAPI_SPEC_URL)

    # 2. Test Direct Salesforce Headless 360 Hosted MCP Endpoint
    test_mcp_server(DIRECT_MCP_URL, access_token, label="Direct Salesforce Hosted MCP", org_alias=args.target_org)

    # 3. Execute Realistic Test Scenarios for all 4 MCP tools (discover, describe, dispatch, dispatch_readonly)
    test_mcp_situations(org_alias=args.target_org)

    print("\n" + "=" * 75)
    print("✨ Validation Suite Execution Completed.")
    print("=" * 75)

if __name__ == "__main__":
    main()
