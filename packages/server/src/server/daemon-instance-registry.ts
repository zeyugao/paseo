import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { open, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";

import { hostname as getOsHostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "./private-files.js";
import { getMachineId } from "./machine-id.js";
import { withReclaimLock } from "./pid-lock.js";

const DAEMON_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const DAEMON_INSTANCE_STALE_AFTER_MS = 120_000;
const READ_RETRY_ATTEMPTS = 10;
const READ_RETRY_DELAY_MS = 50;

export const daemonInstanceInfoSchema = z.object({
  serverId: z.string(),
  hostname: z.string(),
  machineId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  bootId: z.string().uuid(),
  startedAt: z.string(),
  listen: z.string().optional(),
});

export interface DaemonInstanceInfo extends z.infer<typeof daemonInstanceInfoSchema> {}

export class DaemonInstanceRegistryError extends Error {
  constructor(
    message: string,
    public readonly existingInstance?: DaemonInstanceInfo,
  ) {
    super(message);
    this.name = "DaemonInstanceRegistryError";
  }
}
export class DaemonInstanceLeaseLostError extends DaemonInstanceRegistryError {
  constructor(
    public readonly expectedInstance: DaemonInstanceInfo,
    public readonly currentInstance: DaemonInstanceInfo | null,
  ) {
    super(
      `Daemon instance lease lost for serverId ${expectedInstance.serverId}`,
      currentInstance ?? undefined,
    );
    this.name = "DaemonInstanceLeaseLostError";
  }
}

export interface DaemonInstanceRegistration {
  readonly info: DaemonInstanceInfo;
  updateListen(listen: string): Promise<void>;
  release(): Promise<void>;
}

interface RegisterDaemonInstanceOptions {
  hostname?: string;
  machineId?: string;
  ownerPid?: number;
  listen?: string;
  heartbeatIntervalMs?: number;
  onHeartbeatError?: (error: unknown) => void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function instancePath(paseoHome: string, serverId: string): string {
  return path.join(paseoHome, "daemons", serverId, "instance.json");
}

async function readInstanceFile(filePath: string): Promise<DaemonInstanceInfo | null> {
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const parsed = daemonInstanceInfoSchema.safeParse(
        JSON.parse(await readFile(filePath, "utf8")),
      );
      if (parsed.success) return parsed.data;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
    }
    if (attempt < READ_RETRY_ATTEMPTS - 1) {
      await delay(READ_RETRY_DELAY_MS);
    }
  }
  throw new DaemonInstanceRegistryError(`Cannot read daemon instance registry at ${filePath}`);
}

async function writeInstanceFileAtomic(filePath: string, info: DaemonInstanceInfo): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function clearStaleCorruptInstance(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    if (Date.now() - fileStat.mtimeMs <= DAEMON_INSTANCE_STALE_AFTER_MS) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

export function getDaemonInstancePath(paseoHome: string, serverId: string): string {
  return instancePath(paseoHome, serverId);
}

export async function readRegisteredDaemonInstance(
  paseoHome: string,
  serverId: string,
): Promise<DaemonInstanceInfo | null> {
  return readInstanceFile(instancePath(paseoHome, serverId));
}
/**
 * Synchronous, lock-free release for hard-exit paths (supervisor loss, tree-kill).
 * Must not spawn child processes (flock) — the tree-kill test expects the
 * entire process tree to die. The lock-free read is safe in the exit path
 * because no other code in this process is running.
 */
export function releaseDaemonInstanceSync(
  paseoHome: string,
  serverId: string,
  workerPid: number,
  hostname = getOsHostname(),
): boolean {
  const filePath = instancePath(paseoHome, serverId);
  try {
    const raw = readFileSync(filePath, "utf8");
    const current = JSON.parse(raw) as DaemonInstanceInfo;
    if (current.pid !== workerPid || current.hostname !== hostname) return false;
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function releaseDaemonInstanceForExitedWorker(
  paseoHome: string,
  serverId: string,
  workerPid: number,
  hostname = getOsHostname(),
): Promise<boolean> {
  const filePath = instancePath(paseoHome, serverId);
  const reclaimLockPath = path.join(path.dirname(filePath), ".reclaim.lock");
  return withReclaimLock(reclaimLockPath, async () => {
    const current = await readInstanceFile(filePath);
    if (current?.pid !== workerPid || current.hostname !== hostname) return false;
    await unlink(filePath);
    return true;
  });
}

async function clearAbandonedInstance(
  filePath: string,
  existing: DaemonInstanceInfo,
  options: Required<Pick<RegisterDaemonInstanceOptions, "hostname" | "machineId">>,
): Promise<void> {
  const fileStat = await stat(filePath);
  const stale = Date.now() - fileStat.mtimeMs > DAEMON_INSTANCE_STALE_AFTER_MS;
  const sameMachine = existing.machineId
    ? existing.machineId === options.machineId
    : existing.hostname === options.hostname;

  if (!stale && !sameMachine) {
    throw new DaemonInstanceRegistryError(
      `Paseo serverId ${existing.serverId} is already active on ${existing.hostname}. Set a different PASEO_SERVER_ID for this machine.`,
      existing,
    );
  }
  if (!stale) {
    throw new DaemonInstanceRegistryError(
      `Another Paseo daemon is already running (PID ${existing.pid}, started ${existing.startedAt})`,
      existing,
    );
  }

  await unlink(filePath);
}

export async function registerDaemonInstance(
  paseoHome: string,
  serverId: string,
  options: RegisterDaemonInstanceOptions = {},
): Promise<DaemonInstanceRegistration> {
  const hostname = options.hostname ?? getOsHostname();
  const machineId = options.machineId ?? (await getMachineId());
  const ownerPid = options.ownerPid ?? process.pid;
  const filePath = instancePath(paseoHome, serverId);
  const reclaimLockPath = path.join(path.dirname(filePath), ".reclaim.lock");
  ensurePrivateDirectory(path.dirname(filePath));

  const info: DaemonInstanceInfo = {
    serverId,
    hostname,
    machineId,
    pid: ownerPid,
    bootId: randomUUID(),
    startedAt: new Date().toISOString(),
    ...(options.listen ? { listen: options.listen } : {}),
  };

  const handle = await withReclaimLock(reclaimLockPath, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let existing: DaemonInstanceInfo | null;
      try {
        existing = await readInstanceFile(filePath);
      } catch (error) {
        if (await clearStaleCorruptInstance(filePath)) continue;
        throw error;
      }
      if (!existing) {
        await writeInstanceFileAtomic(filePath, info);
        return open(filePath, "r+");
      }
      await clearAbandonedInstance(filePath, existing, { hostname, machineId });
    }
    throw new DaemonInstanceRegistryError(
      "Daemon instance registry changed repeatedly while reclaiming it",
    );
  });

  const instanceHandle = handle;
  let released = false;
  let heartbeatPending = false;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DAEMON_INSTANCE_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    if (heartbeatPending || released) return;
    heartbeatPending = true;
    void (async () => {
      try {
        await withReclaimLock(reclaimLockPath, async () => {
          const current = await readInstanceFile(filePath);
          if (released) return;
          if (
            !current ||
            current.serverId !== info.serverId ||
            current.bootId !== info.bootId ||
            current.pid !== info.pid
          ) {
            throw new DaemonInstanceLeaseLostError(info, current);
          }
          if (released) return;
          const now = new Date();
          await utimes(filePath, now, now);
        });
      } catch (error) {
        if (!released) options.onHeartbeatError?.(error);
      } finally {
        heartbeatPending = false;
      }
    })();
  }, heartbeatIntervalMs);
  timer.unref();

  return {
    info,
    async updateListen(listen: string): Promise<void> {
      const updatedInfo = { ...info, listen };
      await withReclaimLock(reclaimLockPath, async () => {
        if (released) throw new DaemonInstanceRegistryError("Daemon instance is already released");
        const current = await readInstanceFile(filePath);
        if (
          !current ||
          current.serverId !== info.serverId ||
          current.bootId !== info.bootId ||
          current.pid !== info.pid
        ) {
          throw new DaemonInstanceLeaseLostError(info, current);
        }
        await writeInstanceFileAtomic(filePath, updatedInfo);
        const now = new Date();
        await utimes(filePath, now, now);
        info.listen = listen;
      });
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(timer);
      await withReclaimLock(reclaimLockPath, async () => {
        await instanceHandle.close();
        try {
          const current = await readInstanceFile(filePath);
          if (current?.bootId === info.bootId) await unlink(filePath);
        } catch (error) {
          if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
        }
      });
    },
  };
}
