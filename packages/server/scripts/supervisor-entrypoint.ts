import { fileURLToPath } from "url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  acquirePidLock,
  PidLockError,
  releasePidLock,
  startPidLockHeartbeat,
  updatePidLock,
} from "../src/server/pid-lock.js";
import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { daemonLogPath } from "../src/server/daemon-instance.js";
import {
  getDaemonInstancePath,
  releaseDaemonInstanceForExitedWorker,
} from "../src/server/daemon-instance-registry.js";
import { PRIVATE_FILE_MODE } from "../src/server/private-files.js";
import { loadPersistedConfig } from "../src/server/persisted-config.js";
import { reapTerminalWorkers } from "../src/terminal/terminal-worker-reaper.js";
import { terminalWorkerHome } from "../src/terminal/terminal-worker-record.js";
import { getOrCreateServerId } from "../src/server/server-id.js";
import { runSupervisor } from "./supervisor.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

process.title = "Paseo Supervisor";

interface DaemonRunnerConfig {
  devMode: boolean;
  workerArgs: string[];
}

function parseConfig(argv: string[]): DaemonRunnerConfig {
  let devMode = false;
  const workerArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--dev") {
      devMode = true;
      continue;
    }
    if (arg === "--reclaim-stale-pid-lock") {
      throw new Error(
        "--reclaim-stale-pid-lock was removed: stop the existing supervisor before starting another.",
      );
    }
    workerArgs.push(arg);
  }

  return { devMode, workerArgs };
}

function resolveWorkerEntry(): string {
  const candidates = [
    fileURLToPath(new URL("../server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url)),
    fileURLToPath(new URL("../../src/server/daemon-worker.ts", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDevWorkerEntry(): string {
  const candidate = fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(`Dev worker entry not found: ${candidate}`);
  }
  return candidate;
}

function resolveWorkerExecArgv(workerEntry: string, devMode: boolean): string[] {
  const execArgv = workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
  if (!devMode) {
    return execArgv;
  }
  const devArgs = [
    "--heapsnapshot-near-heap-limit=3",
    "--max-old-space-size=3072",
    "--report-on-fatalerror",
    "--report-directory=/tmp/paseo-reports",
  ];
  const inspectArg = process.env.PASEO_NODE_INSPECT ?? "--inspect";
  if (inspectArg !== "0" && inspectArg !== "false" && inspectArg !== "off") {
    devArgs.push(inspectArg);
  }
  return [...devArgs, ...execArgv];
}

function resolvePackagedNodeEntrypointRunnerPath(currentScriptPath: string): string | null {
  const packageMarker = `${path.sep}node_modules${path.sep}@getpaseo${path.sep}server${path.sep}`;
  const markerIndex = currentScriptPath.lastIndexOf(packageMarker);
  if (markerIndex === -1) {
    return null;
  }

  const appRoot = currentScriptPath.slice(0, markerIndex);
  const runnerPath = path.join(appRoot, "dist", "daemon", "node-entrypoint-runner.js");
  return existsSync(runnerPath) ? runnerPath : null;
}

export const PID_LOCK_HEARTBEAT_FAILURE_LIMIT = 3;

export function createPidLockHeartbeatCallbacks(input: {
  reportError: (message: string) => void;
  requestShutdown: (reason: string) => void;
}): { onSuccess: () => void; onError: (error: unknown) => void } {
  let consecutiveFailures = 0;
  let shutdownRequested = false;
  return {
    onSuccess: () => {
      consecutiveFailures = 0;
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      input.reportError(message);
      if (shutdownRequested) return;
      consecutiveFailures += 1;
      if (error instanceof PidLockError) {
        shutdownRequested = true;
        input.requestShutdown("pid_lock_ownership_lost");
        return;
      }
      if (consecutiveFailures >= PID_LOCK_HEARTBEAT_FAILURE_LIMIT) {
        shutdownRequested = true;
        input.requestShutdown("pid_lock_heartbeat_failed");
      }
    },
  };
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();
  const workerExecArgv = resolveWorkerExecArgv(workerEntry, config.devMode);
  const workerEnv: NodeJS.ProcessEnv = { ...process.env };
  workerEnv.PASEO_SUPERVISED = "1";
  const packagedNodeEntrypointRunner =
    process.env.ELECTRON_RUN_AS_NODE === "1"
      ? resolvePackagedNodeEntrypointRunnerPath(fileURLToPath(import.meta.url))
      : null;

  const paseoHome = resolvePaseoHome(workerEnv);
  const persistedConfig = loadPersistedConfig(paseoHome);
  const supervisorLogFile = resolveSupervisorLogFile(paseoHome, persistedConfig, workerEnv);
  const selectedServerId = getOrCreateServerId(paseoHome, { env: workerEnv });
  workerEnv.PASEO_SERVER_ID = selectedServerId;
  workerEnv.PASEO_LOG_FILE_PATH = supervisorLogFile.path;
  const pidLockHome = path.dirname(getDaemonInstancePath(paseoHome, selectedServerId));
  try {
    const ownsPidLock = await acquirePidLock(pidLockHome, null, {
      ownerPid: process.pid,
    });
    if (!ownsPidLock) {
      throw new PidLockError(
        `Another Paseo daemon is already running for serverId ${selectedServerId}`,
      );
    }
  } catch (error) {
    if (error instanceof PidLockError) {
      failStartup(error.message, error.message);
    }
    throw error;
  }
  // Credentials and discovery are instance-scoped; this supervisor never owns the root pointer.
  workerEnv.PASEO_PID_LOCK_OWNER = "0";

  let lockReleased = false;
  let requestSupervisorShutdown: ((reason: string) => void) | null = null;
  const heartbeatCallbacks = createPidLockHeartbeatCallbacks({
    reportError: (message) => {
      process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
    },
    requestShutdown: (reason) => requestSupervisorShutdown?.(reason),
  });
  const stopLockHeartbeat = startPidLockHeartbeat(pidLockHome, {
    ownerPid: process.pid,
    ...heartbeatCallbacks,
  });
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    stopLockHeartbeat();
    await releasePidLock(pidLockHome, {
      ownerPid: process.pid,
    });
  };

  // Keep the selected/ready identity after worker exit clears the discovery pointer, including
  // a stop during startup before a replacement can announce ready.
  let terminalServerId: string | null = selectedServerId;
  const supervisor = runSupervisor({
    name: "DaemonRunner",
    startupMessage: "Starting daemon worker (IPC restart and crash restart enabled)",
    resolveWorkerEntry: () => workerEntry,
    workerArgs: config.workerArgs,
    workerEnv,
    workerExecArgv,
    resolveWorkerSpawnSpec: packagedNodeEntrypointRunner
      ? (resolvedWorkerEntry) => ({
          command: process.execPath,
          args: [
            packagedNodeEntrypointRunner,
            "node-script",
            resolvedWorkerEntry,
            ...config.workerArgs,
          ],
          env: {
            ...workerEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
        })
      : undefined,
    restartOnCrash: true,
    logFile: supervisorLogFile,
    onWorkerReady: async ({ listen, serverId }) => {
      terminalServerId = serverId;
      await updatePidLock(pidLockHome, { listen, serverId }, { ownerPid: process.pid });
    },
    onWorkerExit: async ({ pid, serverId }) => {
      if (pid !== null && serverId !== null) {
        await releaseDaemonInstanceForExitedWorker(paseoHome, serverId, pid);
      }
      await updatePidLock(pidLockHome, { listen: null, serverId: null }, { ownerPid: process.pid });
    },
    onSupervisorExit: releaseLock,
    cleanupTerminals: async (log) => {
      if (terminalServerId === null) return;
      const result = await reapTerminalWorkers({
        paseoHome: terminalWorkerHome(paseoHome, terminalServerId),
        log,
      });
      log("Terminal worker cleanup result", { ...result });
    },
  });
  requestSupervisorShutdown = supervisor.requestShutdown;
}

// The supervisor opens its log only after config and the PID lock succeed. A background
// launch discards stderr, so earlier failures also go to the log the launcher points at.
function failStartup(detail: string, summary: string): never {
  process.stderr.write(`${detail}\n`);
  try {
    const logPath = daemonLogPath(resolvePaseoHome(process.env));
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        level: "fatal",
        time: new Date().toISOString(),
        pid: process.pid,
        name: "DaemonRunner",
        msg: summary,
      })}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
  } catch {
    // stderr already carries the failure.
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    if (error instanceof Error) failStartup(error.stack ?? error.message, error.message);
    failStartup(String(error), String(error));
  });
}
