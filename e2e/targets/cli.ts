// The supervised local CLI daemon as a target. `executor service install` boots
// an OS-managed daemon (launchd / systemd / Task Scheduler) inside a guest VM;
// `restart()` reboots that guest for REAL, so restart-persistence proves the
// boot-time auto-start path (RunAtLoad / linger / AtStartup), not just a process
// restart. The guest daemon binds loopback, so globalsetup forwards it to a
// local port over a reconnecting SSH tunnel — making target.baseUrl work
// unchanged for the api surface. Boot + tunnel live in setup/cli.globalsetup.ts;
// this target only reads what that published via env.
import { Effect } from "effect";

import { waitForHttp } from "../setup/boot";
import { sshRebootGuest } from "../src/vm/tart";
import type { VmOs } from "../src/vm/types";
import type { Capability, Identity, Target } from "../src/target";

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`cli target: ${key} not set — did cli.globalsetup run?`);
  return value;
};

export const cliTarget = (): Target => {
  const baseUrl = env("E2E_CLI_BASE_URL");
  const os = (process.env.E2E_VM_OS ?? "macos") as VmOs;
  const username = process.env.E2E_CLI_AUTH_USER ?? "executor";

  return {
    name: process.env.E2E_TARGET ?? "cli",
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    capabilities: new Set<Capability>(["api"]),
    newIdentity: () =>
      Effect.sync((): Identity => {
        const basic = Buffer.from(`${username}:${env("E2E_CLI_AUTH_PASSWORD")}`).toString("base64");
        return { label: "cli-daemon", headers: { Authorization: `Basic ${basic}` } };
      }),
    // A genuine machine reboot, not a service kick: reboot the guest OS and wait
    // for the supervised daemon to auto-start and serve again (401 = up). The
    // reconnecting tunnel re-establishes the forward, so the same baseUrl works.
    restart: () =>
      Effect.promise(async () => {
        if (os === "windows") throw new Error("cli-windows restart pending the ec2 provider");
        await sshRebootGuest(env("E2E_CLI_VM_HOST"));
        await waitForHttp(`${baseUrl}/`, { timeoutMs: 240_000 });
      }),
  };
};
