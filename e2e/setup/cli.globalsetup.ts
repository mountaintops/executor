// Boot the `cli` target: build the guest's `executor` binary, provision a VM,
// install it as a supervised OS service, and forward its loopback HTTP port to
// the host over a reconnecting SSH tunnel. Publishes connection + reboot info
// via env (inherited by the test workers spawned afterward). Per-OS entrypoints
// (cli-macos.globalsetup.ts, …) call setupCliTarget with their OS.
import { buildGuestBinary } from "../src/vm/build-binary";
import { tartVm } from "../src/vm/tart";
import type { VmArch, VmOs } from "../src/vm/types";
import { waitForHttp } from "./boot";

const PORT = 4789;
const GUEST_DIR = "~/ed";

export async function setupCliTarget(os: VmOs): Promise<(() => Promise<void>) | void> {
  process.env.E2E_VM_OS = os; // so the worker-side target resolves the same OS
  if (os === "windows") {
    throw new Error("cli-windows is pending the ec2 provider; run cli-macos / cli-linux for now");
  }

  const arch: VmArch = "arm64"; // tart guests on an Apple-Silicon host
  const binDir = await buildGuestBinary(os, arch);
  const vm = await tartVm(os, arch).provision();

  let tunnelClose: (() => void) | undefined;
  try {
    await vm.ssh(`rm -rf ${GUEST_DIR} && mkdir -p ${GUEST_DIR}`);
    await vm.push(`${binDir}/.`, `${GUEST_DIR}/`);
    // macOS quarantines scp'd executables; clear it so the binary can run.
    await vm.ssh(
      os === "macos"
        ? `chmod +x ${GUEST_DIR}/executor; xattr -dr com.apple.quarantine ${GUEST_DIR} 2>/dev/null || true`
        : `chmod +x ${GUEST_DIR}/executor`,
    );

    const install = await vm.ssh(`${GUEST_DIR}/executor service install --port ${PORT}`);
    if (install.code !== 0) {
      throw new Error(`service install failed: ${install.stderr.trim() || install.stdout.trim()}`);
    }

    const keyRaw = (await vm.ssh("cat ~/.executor/server-control/service.key")).stdout.trim();
    const password = (JSON.parse(keyRaw) as { password: string }).password;

    const tunnel = await vm.tunnel(PORT);
    tunnelClose = tunnel.close;
    const baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
    await waitForHttp(`${baseUrl}/`, { timeoutMs: 60_000 });

    process.env.E2E_CLI_BASE_URL = baseUrl;
    process.env.E2E_CLI_AUTH_PASSWORD = password;
    process.env.E2E_CLI_VM_HOST = vm.host;
    process.env.E2E_CLI_TUNNEL_PORT = String(tunnel.localPort);
    process.env.E2E_CLI_BIN_DIR = GUEST_DIR;
  } catch (error) {
    tunnelClose?.();
    await vm.ssh(`${GUEST_DIR}/executor service uninstall`).catch(() => undefined);
    await vm.discard();
    throw error;
  }

  return async () => {
    tunnelClose?.();
    await vm.ssh(`${GUEST_DIR}/executor service uninstall`).catch(() => undefined);
    await vm.discard();
  };
}
