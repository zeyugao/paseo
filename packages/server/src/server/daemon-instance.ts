import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
  isLocked,
  isSamePidLock,
  releasePidLock,
  PidLockError,
  type PidLockInfo,
} from "./pid-lock.js";
import { daemonLaunchEnvironment } from "./config-environment.js";
import { readPersistedConfig } from "./persisted-config.js";
import { reapTerminalWorkers } from "../terminal/terminal-worker-reaper.js";
import { terminalWorkerHome } from "../terminal/terminal-worker-record.js";
import { retryUnconfirmedTerminalCleanup as retryTerminalCleanup } from "../terminal/terminal-worker-reaper.js";
import {
  isRegisteredDaemonOwnerRunning,
  readRegisteredDaemonInstance,
  type DaemonInstanceInfo,
} from "./daemon-instance-registry.js";
import { readMachineId } from "./machine-id.js";
import { readServerId } from "./server-id.js";
import { getHostName } from "./host-name.js";
import { createTerminalWorkerProcessInspector } from "../terminal/terminal-worker-processes.js";
import treeKill from "tree-kill";
const killTree = (pid: number, signal: string): Promise<void> =>
  new Promise((resolve, reject) =>
    treeKill(pid, signal, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );

// Process ownership only: desktop and CLI load this entry in their own processes.
// Keep daemon bootstrap and WebSocket schemas out of its dependency tree.
export { resolvePaseoHome } from "./paseo-home.js";
export { ensurePrivateDirectory } from "./private-files.js";
export { daemonLaunchEnvironment } from "./config-environment.js";
export { readLocalCredentialForTarget } from "./local-credential.js";
export { TerminalCleanupNotConfirmedError } from "../terminal/terminal-worker-reaper.js";
export {
  isSamePidLock as isSameDaemonInstance,
  type PidLockInfo as DaemonInstance,
} from "./pid-lock.js";

export class DaemonInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readDaemonInstance(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PidLockInfo | null> {
  const serverId = readServerId(home, env);
  if (serverId) {
    const registered = await readRegisteredDaemonInstance(home, serverId);
    if (registered) {
      if (registered.serverId !== serverId) return null;
      return readRegisteredInstance(home, registered);
    }
  }
  const state = await isLocked(home);
  if (
    !state.locked ||
    !state.info ||
    (serverId && state.info.serverId && state.info.serverId !== serverId)
  )
    return null;
  return state.info;
}

async function readRegisteredInstance(
  home: string,
  registered: DaemonInstanceInfo,
): Promise<PidLockInfo | null> {
  const machineId = await readMachineId();
  if (!machineId || !(await isRegisteredDaemonOwnerRunning(registered, machineId))) return null;
  const confirmed = await readRegisteredDaemonInstance(home, registered.serverId);
  if (!confirmed || confirmed.bootId !== registered.bootId || confirmed.pid !== registered.pid) {
    return null;
  }
  const owner = registered.supervisor ?? {
    pid: registered.pid,
    startedAt: registered.processStartedAt!,
  };
  const pointer = await readMatchingPointer(home, registered.serverId, machineId, owner);
  if (pointer)
    return { ...pointer, serverId: registered.serverId, processStartedAt: owner.startedAt };
  return {
    pid: owner.pid,
    startedAt: owner.startedAt,
    processStartedAt: owner.startedAt,
    machineId,
    hostname: getHostName(),
    uid: process.getuid?.() ?? 0,
    serverId: registered.serverId,
    listen: registered.listen ?? null,
    ...(registered.machineBootId ? { bootId: registered.machineBootId } : {}),
    ...(registered.desktopManaged ? { desktopManaged: true } : {}),
  };
}

async function readMatchingPointer(
  home: string,
  serverId: string,
  machineId: string,
  owner: { pid: number; startedAt: string },
): Promise<PidLockInfo | null> {
  const pointer = await getPidLockInfo(home).catch((error: unknown) => {
    if (error instanceof PidLockError) return null;
    throw error;
  });
  if (
    pointer?.pid === owner.pid &&
    (!pointer.serverId || pointer.serverId === serverId) &&
    (!pointer.machineId || pointer.machineId === machineId) &&
    (!pointer.processStartedAt || pointer.processStartedAt === owner.startedAt) &&
    isPidLockOwnerRunning(pointer)
  )
    return pointer;
  return null;
}

export function retryUnconfirmedTerminalCleanup(home: string, serverId: string) {
  return retryTerminalCleanup(terminalWorkerHome(home, serverId));
}

async function instanceRunning(instance: PidLockInfo): Promise<boolean> {
  if (!isPidLockOwnerRunning(instance)) return false;
  if (!instance.processStartedAt) return true;
  const inspected = await createTerminalWorkerProcessInspector().inspect(instance.pid);
  if (inspected.status === "error") throw inspected.error;
  return inspected.status === "alive" && inspected.snapshot.startedAt === instance.processStartedAt;
}

export function daemonLogPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const serverId = env.PASEO_SERVER_ID?.trim();
  const defaultFilename = serverId ? `daemon.${serverId}.log` : "daemon.log";
  try {
    return path.resolve(home, readPersistedConfig(home).log?.file?.path ?? defaultFilename);
  } catch {
    return path.join(home, defaultFilename);
  }
}

export async function waitForDaemonReady(
  home: string,
  options: {
    timeoutMs?: number;
    instance?: PidLockInfo;
    signal?: AbortSignal;
  } = {},
): Promise<PidLockInfo & { listen: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  while (true) {
    options.signal?.throwIfAborted();
    const instance = await readDaemonInstance(home);
    if (!instance)
      throw new DaemonInstanceError(
        "DAEMON_NOT_RUNNING",
        `Daemon is not running for ${home}. Start with: paseo daemon start --home ${JSON.stringify(home)}`,
      );
    if (options.instance && !isSamePidLock(instance, options.instance)) {
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor changed for ${home}; refusing to follow PID ${instance.pid}.`,
      );
    }
    if (instance.listen) return { ...instance, listen: instance.listen };
    if (Date.now() >= deadline) throw notReady(home, instance);
    await delay(100, undefined, { signal: options.signal });
  }
}

function notReady(home: string, instance: PidLockInfo): DaemonInstanceError {
  return new DaemonInstanceError(
    "DAEMON_NOT_READY",
    `Daemon PID ${instance.pid} remains running but is not ready for ${home}.\nLogs: ${daemonLogPath(home)}\nStatus: paseo daemon status --home ${JSON.stringify(home)}\nStop: paseo daemon stop --home ${JSON.stringify(home)}`,
  );
}

async function requestInstanceStop(
  home: string,
  instance: PidLockInfo,
  options: {
    force?: boolean;
    keepTerminals?: boolean;
    env?: NodeJS.ProcessEnv;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  },
) {
  let forced = false;
  let usedLifecycleRpc = false;
  if (options.keepTerminals) {
    // SIGTERM means "stop and close terminals"; keeping them always goes over the RPC.
    if (!instance.listen || !options.requestShutdown) {
      throw new DaemonInstanceError(
        "STOP_NO_GRACEFUL_CHANNEL",
        `PID ${instance.pid} for ${home} has no listen address, so it cannot be asked to keep its terminals.`,
      );
    }
    await options.requestShutdown({ ...instance, listen: instance.listen });
    return { forced, usedLifecycleRpc: true };
  }
  if (process.platform === "win32") {
    if (instance.listen && options.requestShutdown) {
      try {
        await options.requestShutdown({ ...instance, listen: instance.listen });
        usedLifecycleRpc = true;
      } catch (error) {
        if (!options.force) throw error;
        const current = await readDaemonInstance(home, options.env);
        if (current && !isSamePidLock(instance, current))
          throw new DaemonInstanceError(
            "DAEMON_REPLACED",
            `Supervisor changed for ${home}; refusing forced cleanup.`,
          );
        if (await instanceRunning(instance)) await killTree(instance.pid, "SIGKILL");
        forced = true;
      }
    } else if (!options.force) {
      throw new DaemonInstanceError(
        "STOP_NO_GRACEFUL_CHANNEL",
        `PID ${instance.pid} for ${home} has no graceful shutdown channel. Use --force explicitly to terminate it.`,
      );
    } else {
      if (await instanceRunning(instance)) await killTree(instance.pid, "SIGKILL");
      forced = true;
    }
  } else {
    try {
      if (await instanceRunning(instance)) process.kill(instance.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return { forced, usedLifecycleRpc };
}

export async function stopDaemonInstance(
  home: string,
  options: {
    instance?: PidLockInfo;
    env?: NodeJS.ProcessEnv;
    force?: boolean;
    // Leave the terminal worker running so the next daemon adopts it. Not valid with force.
    keepTerminals?: boolean;
    timeoutMs?: number;
    killTimeoutMs?: number;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  } = {},
): Promise<{
  action: "stopped" | "not_running";
  pid: number | null;
  forced: boolean;
  usedLifecycleRpc: boolean;
}> {
  const { timeoutMs = 15_000, killTimeoutMs = 3_000, env } = options;
  assertStopOptions(options);
  const deadline = Date.now() + timeoutMs;
  const instance = await readDaemonInstance(home, env);
  if (options.instance && instance && !isSamePidLock(instance, options.instance)) {
    throw new DaemonInstanceError(
      "DAEMON_REPLACED",
      `Supervisor changed for ${home}; refusing to stop PID ${instance.pid}.`,
    );
  }
  if (!instance) {
    await cleanIdleInstance(home, options.keepTerminals, env);
    return {
      action: "not_running",
      pid: null,
      forced: false,
      usedLifecycleRpc: false,
    };
  }
  if (instance.pid <= 1 || instance.pid === process.pid)
    throw new Error("Refusing to stop invalid supervisor PID");
  let { forced, usedLifecycleRpc } = await requestInstanceStop(home, instance, options);
  const waitForExit = async (waitMs: number) => {
    const exitDeadline = Date.now() + waitMs;
    while (await instanceRunning(instance)) {
      const current = await readDaemonInstance(home, env);
      if (current && !isSamePidLock(instance, current))
        throw new DaemonInstanceError(
          "DAEMON_REPLACED",
          `Supervisor changed for ${home}; stop of PID ${instance.pid} was not confirmed.`,
        );
      if (Date.now() >= exitDeadline) return false;
      await delay(100);
    }
    return true;
  };
  let stopped = await waitForExit(forced ? killTimeoutMs : Math.max(0, deadline - Date.now()));
  if (!stopped && options.force && !forced) {
    await forceInstanceStop(home, instance, env);
    forced = true;
    stopped = await waitForExit(killTimeoutMs);
  }
  if (!stopped)
    throw new DaemonInstanceError(
      "STOP_NOT_CONFIRMED",
      `Timed out waiting for supervisor PID ${instance.pid} in ${home} to exit${options.force ? "" : "; use --force to permit forced cleanup"}.`,
    );
  await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
  // The supervisor already closed the terminals unless it was killed; this confirms it, and
  // after --force (no graceful shutdown happened) does it at once.
  await closeLeftoverTerminals(home, instance.serverId ?? readServerId(home, env), {
    keepTerminals: options.keepTerminals,
    forced,
  });
  return { action: "stopped", pid: instance.pid, forced, usedLifecycleRpc };
}

async function forceInstanceStop(
  home: string,
  instance: PidLockInfo,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  const current = await readDaemonInstance(home, env);
  if (current && !isSamePidLock(instance, current)) {
    throw new DaemonInstanceError(
      "DAEMON_REPLACED",
      `Supervisor changed for ${home}; refusing forced cleanup.`,
    );
  }
  if (await instanceRunning(instance)) await killTree(instance.pid, "SIGKILL");
}

async function cleanIdleInstance(
  home: string,
  keepTerminals: boolean | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  const pointer = await getPidLockInfo(home);
  const serverId = readServerId(home, env);
  if (
    pointer &&
    (!serverId || !pointer.serverId || pointer.serverId === serverId) &&
    !isPidLockOwnerRunning(pointer)
  ) {
    await releasePidLock(home, { ownerPid: pointer.pid, startedAt: pointer.startedAt });
  }
  // A plain stop also closes this selected instance's previously retained terminals.
  const registered = serverId ? await readRegisteredDaemonInstance(home, serverId) : null;
  const localMachineId = registered ? await readMachineId() : null;
  if (!registered || (localMachineId && registered.machineId === localMachineId)) {
    await closeLeftoverTerminals(home, serverId, { keepTerminals, forced: false });
  }
}

function assertStopOptions(options: { force?: boolean; keepTerminals?: boolean }): void {
  if (options.force && options.keepTerminals) {
    throw new DaemonInstanceError(
      "INVALID_STOP_OPTIONS",
      "--force kills terminals; it cannot be combined with --keep-terminals.",
    );
  }
}

async function closeLeftoverTerminals(
  home: string,
  serverId: string | null,
  options: { keepTerminals?: boolean; forced: boolean },
): Promise<void> {
  if (options.keepTerminals || !serverId) return;
  await reapTerminalWorkers({
    paseoHome: terminalWorkerHome(home, serverId),
    gracefulMs: options.forced ? 0 : undefined,
  });
}

export async function startDaemonInstance(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
  foreground?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAcquired?: (instance: PidLockInfo) => void;
  onReady?: (instance: PidLockInfo & { listen: string }) => void;
}): Promise<{ instance: PidLockInfo; spawned: boolean; exitCode?: number }> {
  input.signal?.throwIfAborted();
  const existing = await readDaemonInstance(input.home, input.env);
  if (existing) return { instance: existing, spawned: false };
  const {
    foreground = false,
    timeoutMs = 600_000,
    signal,
    onAcquired = () => {},
    onReady = () => {},
  } = input;
  const child = spawn(input.command, input.args, {
    env: daemonLaunchEnvironment(input),
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    windowsHide: true,
  });
  let exit: { code: number; error?: Error } | undefined;
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      exit = { code: 1, error };
      resolve(1);
    });
    child.once("exit", (code) => {
      exit = { code: code ?? 1 };
      resolve(code ?? 1);
    });
  });
  const cancel = () => {
    if (child.pid && !exit) {
      child.ref();
      child.kill("SIGTERM");
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (!foreground) child.unref();
  const deadline = foreground ? Infinity : Date.now() + timeoutMs;
  let acquired: PidLockInfo | undefined;
  async function waitUntilReady() {
    while (true) {
      signal?.throwIfAborted();
      const instance = await readDaemonInstance(input.home, input.env);
      if (instance && instance.pid !== child.pid) return { instance, spawned: false };
      if (instance && !acquired) {
        acquired = instance;
        onAcquired(instance);
      }
      if (exit) {
        const logPath = daemonLogPath(input.home);
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new DaemonInstanceError(
          "DAEMON_START_FAILED",
          `Daemon failed to start (${exit.error?.message ?? `exit ${exit.code}`}). Logs: ${logPath}\n${log.split("\n").slice(-30).join("\n")}`,
        );
      }
      if (instance?.listen) {
        const ready = { ...instance, listen: instance.listen };
        onReady(ready);
        return {
          instance: ready,
          spawned: true,
          ...(foreground ? { exitCode: await exited } : {}),
        };
      }
      if (Date.now() >= deadline) {
        if (acquired) throw notReady(input.home, acquired);
        throw new DaemonInstanceError(
          "DAEMON_NOT_READY",
          `Supervisor PID ${child.pid} remains running but has not published its lock for ${input.home}. Logs: ${daemonLogPath(input.home)}. Check paseo daemon status --home ${JSON.stringify(input.home)}. Stop with paseo daemon stop --home ${JSON.stringify(input.home)} once its lock is published, or signal this PID.`,
        );
      }
      await delay(100, undefined, { signal });
    }
  }
  try {
    return await waitUntilReady();
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) {
      cancel();
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(15_000, false, { ref: false }),
      ]);
      if (!stopped && child.pid) {
        await killTree(child.pid, "SIGKILL");
        await exited;
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
