import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "./private-files.js";
import { dirname, join } from "node:path";
import { uptime } from "node:os";
import { getHostName } from "./host-name.js";
import { z } from "zod";

function removeMarkerIfExists(markerPath: string): void {
  try {
    unlinkSync(markerPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}
export const pidLockInfoSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  hostname: z.string(),
  uid: z.number(),
  listen: z.string().nullable(),
  serverId: z.string().nullable().optional(),
  desktopManaged: z.boolean().optional(),
  heartbeat: z.literal(true).optional(),
  bootId: z.string().optional(),
});

export interface PidLockInfo extends z.infer<typeof pidLockInfoSchema> {}

function parsePidLockInfo(raw: unknown): PidLockInfo | null {
  const result = pidLockInfoSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class PidLockError extends Error {
  constructor(
    message: string,
    public readonly existingLock?: PidLockInfo,
  ) {
    super(message);
    this.name = "PidLockError";
  }
}

const PID_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const PID_LOCK_READ_RETRY_ATTEMPTS = 10;
const PID_LOCK_READ_RETRY_DELAY_MS = 50;
export const PID_LOCK_STALE_AFTER_MS = 120_000;

const RECLAIM_LOCK_HOLDER = 'printf "\\001"; cat >/dev/null';
const WINDOWS_RECLAIM_LOCK_HOLDER =
  "$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::Out.Write([char]1); [Console]::Out.Flush(); [Console]::In.ReadToEnd() | Out-Null; $stream.Dispose()";
const SYNC_RECLAIM_LOCK_HOLDER =
  'printf "\\001" > "$1"; while [ ! -e "$3" ]; do sleep 0.01; done; printf "\\001" > "$2"';
const WINDOWS_SYNC_RECLAIM_LOCK_HOLDER =
  "$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [System.IO.File]::WriteAllText($args[1], '1'); while (-not (Test-Path -LiteralPath $args[3])) { Start-Sleep -Milliseconds 10 }; $stream.Dispose(); [System.IO.File]::WriteAllText($args[2], '1')";
const SYNC_RECLAIM_LOCK_TIMEOUT_MS = 30_000;
const SYNC_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function waitForLockMarker(markerPath: string, deadline: number, description: string): void {
  while (!existsSync(markerPath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out ${description}`);
    Atomics.wait(SYNC_LOCK_SLEEP, 0, 0, 10);
  }
}

export function withReclaimLockSync<T>(lockPath: string, action: () => T): T {
  ensurePrivateDirectory(dirname(lockPath));
  const lockFd = openSync(lockPath, "a", PRIVATE_FILE_MODE);
  closeSync(lockFd);
  const markerId = `${process.pid}-${randomUUID()}`;
  const acquiredPath = `${lockPath}.${markerId}.acquired`;
  const releasedPath = `${lockPath}.${markerId}.released`;
  const releasePath = `${lockPath}.${markerId}.release`;

  let command = "flock";
  let args = [
    "--exclusive",
    lockPath,
    "/bin/sh",
    "-c",
    SYNC_RECLAIM_LOCK_HOLDER,
    "sync-lock",
    acquiredPath,
    releasedPath,
    releasePath,
  ];
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_SYNC_RECLAIM_LOCK_HOLDER,
      lockPath,
      acquiredPath,
      releasedPath,
      releasePath,
    ];
  } else if (process.platform === "darwin") {
    command = "lockf";
    args = [
      lockPath,
      "/bin/sh",
      "-c",
      SYNC_RECLAIM_LOCK_HOLDER,
      "sync-lock",
      acquiredPath,
      releasedPath,
      releasePath,
    ];
  }

  const holder = spawn(command, args, { stdio: "ignore" });
  holder.on("error", () => {});
  const deadline = Date.now() + SYNC_RECLAIM_LOCK_TIMEOUT_MS;
  try {
    waitForLockMarker(acquiredPath, deadline, `acquiring ${lockPath}`);
    return action();
  } finally {
    writeFileSync(releasePath, "1", { mode: PRIVATE_FILE_MODE });
    try {
      waitForLockMarker(releasedPath, deadline, `releasing ${lockPath}`);
    } finally {
      if (!holder.killed && !existsSync(releasedPath)) holder.kill("SIGKILL");
      for (const markerPath of [acquiredPath, releasedPath, releasePath]) {
        removeMarkerIfExists(markerPath);
      }
    }
  }
}

export async function withReclaimLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  ensurePrivateDirectory(dirname(lockPath));
  const lockFile = await open(lockPath, "a", PRIVATE_FILE_MODE);
  await lockFile.close();

  let command = "flock";
  let args: string[] = ["--exclusive", lockPath, "/bin/sh", "-c", RECLAIM_LOCK_HOLDER];
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECLAIM_LOCK_HOLDER, lockPath];
  } else if (process.platform === "darwin") {
    command = "lockf";
    args = [lockPath, "/bin/sh", "-c", RECLAIM_LOCK_HOLDER];
  }
  const holder = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  type HolderTermination =
    | { kind: "error"; error: Error }
    | { kind: "close"; code: number | null; signal: NodeJS.Signals | null };
  let settleHolderTermination!: (termination: HolderTermination) => void;
  const holderTermination = new Promise<HolderTermination>((resolve) => {
    settleHolderTermination = resolve;
  });
  holder.once("error", (error) => settleHolderTermination({ kind: "error", error }));
  holder.once("close", (code, signal) => settleHolderTermination({ kind: "close", code, signal }));
  let stderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    let acquired = false;
    void holderTermination.then((termination) => {
      if (acquired) return;
      if (termination.kind === "error") {
        reject(termination.error);
        return;
      }
      reject(
        new Error(
          `${command} exited before acquiring ${lockPath} (${termination.code ?? termination.signal}): ${stderr.trim()}`,
        ),
      );
      return;
    });
    holder.stdout.once("data", () => {
      acquired = true;
      resolve();
    });
  });

  let releasing = false;
  let criticalSectionInvalidated = false;
  void holderTermination.then((termination) => {
    if (releasing) return;
    criticalSectionInvalidated = true;
    const reason =
      termination.kind === "error"
        ? termination.error.message
        : String(termination.code ?? termination.signal);
    console.warn(
      `Reclaim lock holder for ${lockPath} exited during the action (${reason}); the critical section is no longer protected`,
    );
    return;
  });

  let releaseError: Error | undefined;
  let result!: T;
  try {
    if (criticalSectionInvalidated || holder.exitCode !== null || holder.signalCode !== null) {
      throw new Error(
        `Reclaim lock holder for ${lockPath} exited before the action began; critical section is no longer protected`,
      );
    }
    result = await action();
    if (criticalSectionInvalidated || holder.exitCode !== null || holder.signalCode !== null) {
      throw new Error(
        `Reclaim lock holder for ${lockPath} exited during the action; critical section is no longer protected`,
      );
    }
  } finally {
    releasing = true;
    if (!holder.stdin.destroyed) holder.stdin.end();
    const termination = await holderTermination;
    if (!criticalSectionInvalidated) {
      if (termination.kind === "error") {
        releaseError = termination.error;
      } else if (termination.code !== 0) {
        releaseError = new Error(
          `${command} failed releasing ${lockPath} (${termination.code ?? termination.signal}): ${stderr.trim()}`,
        );
      }
    }
  }
  if (releaseError) throw releaseError;
  return result;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

// `uptime()` reports whole seconds on some platforms, so the derived boot instant carries
// about a second of error. This covers that resolution and nothing more: every extra second
// is a window in which a lock written just before a reboot still reads as current.
const BOOT_INSTANT_TOLERANCE_MS = 5_000;

function precedesThisBoot(startedAt: string): boolean {
  const stamped = Date.parse(startedAt);
  if (Number.isNaN(stamped)) return false;
  return stamped < Date.now() - uptime() * 1000 - BOOT_INSTANT_TOLERANCE_MS;
}

let cachedBootId: string | null | undefined;

// Linux names each boot. The wall-clock boot instant is not enough there: a VM paused while
// its host sleeps keeps its uptime, so after it resumes the instant lands after locks its
// running supervisor wrote.
function currentBootId(): string | null {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
    } catch {
      cachedBootId = null;
    }
  }
  return cachedBootId;
}

function writtenDuringThisBoot(lock: PidLockInfo): boolean {
  const thisBoot = currentBootId();
  if (lock.bootId && thisBoot) return lock.bootId === thisBoot;
  return !precedesThisBoot(lock.startedAt);
}

/**
 * Whether the process that wrote this lock is still running.
 *
 * A PID alone does not identify the supervisor: the operating system hands the number to
 * something else once the supervisor is gone, and a reboot reassigns it freely. A process
 * cannot predate the boot it runs under, so a lock written during another boot is abandoned
 * however alive its PID looks.
 */
export function isPidLockOwnerRunning(lock: PidLockInfo): boolean {
  if (lock.hostname !== getHostName() || !writtenDuringThisBoot(lock)) return false;
  return isPidRunning(lock.pid);
}

function getPidFilePath(paseoHome: string): string {
  return join(paseoHome, "paseo.pid");
}

async function touchPidLockFile(pidPath: string): Promise<void> {
  const now = new Date();
  await utimes(pidPath, now, now);
}

async function readPidLock(pidPath: string): Promise<PidLockInfo | null> {
  let lastError: unknown;
  let empty = false;
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt++) {
    try {
      const content = await readFile(pidPath, "utf-8");
      empty = content === "";
      if (!empty) {
        const lock = parsePidLockInfo(JSON.parse(content));
        if (lock) return lock;
        lastError = new Error("Invalid lock shape");
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      empty = false;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
  }
  // A supervisor writes its lock right after creating the file, so a file still empty
  // after the retries was abandoned in between and names no owner.
  if (empty) return null;
  throw Object.assign(
    new PidLockError(`Cannot read daemon state at ${pidPath}: ${String(lastError)}`),
    { code: "DAEMON_STATE_READ_FAILED" },
  );
}

function resolveOwnerPid(ownerPid?: number): number {
  if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0) {
    return ownerPid;
  }
  return process.pid;
}

interface AcquirePidLockOptions {
  ownerPid?: number;
}

export function isSamePidLock(left: PidLockInfo, right: PidLockInfo): boolean {
  return (
    left.hostname === right.hostname && left.pid === right.pid && left.startedAt === right.startedAt
  );
}

async function clearExistingPidLock(
  pidPath: string,
  existingLock: PidLockInfo,
  lockOwnerPid: number,
): Promise<"already_owned" | "occupied" | "cleared"> {
  const localHostname = getHostName();
  const sameHost = existingLock.hostname === localHostname;
  const lockOwnerRunning = isPidLockOwnerRunning(existingLock);
  if (sameHost && existingLock.pid === lockOwnerPid && lockOwnerRunning) {
    await touchPidLockFile(pidPath);
    return "already_owned";
  }
  const lockStat = await stat(pidPath);
  const stale = Date.now() - lockStat.mtimeMs > PID_LOCK_STALE_AFTER_MS;
  if (!stale && (lockOwnerRunning || !sameHost)) return "occupied";

  const confirmedLock = await readPidLock(pidPath);
  if (!confirmedLock || !isSamePidLock(existingLock, confirmedLock)) {
    return "occupied";
  }
  const confirmedStat = await stat(pidPath);
  const confirmedStale = Date.now() - confirmedStat.mtimeMs > PID_LOCK_STALE_AFTER_MS;
  if (
    !confirmedStale &&
    (isPidLockOwnerRunning(confirmedLock) || confirmedLock.hostname !== localHostname)
  ) {
    return "occupied";
  }

  try {
    await unlink(pidPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  return "cleared";
}

async function removeEmptyPidLock(pidPath: string): Promise<void> {
  try {
    if ((await stat(pidPath)).size === 0) await unlink(pidPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

async function writeNewPidLock(pidPath: string, lockInfo: PidLockInfo): Promise<boolean> {
  let fd;
  try {
    fd = await open(pidPath, "wx");
    await fd.write(JSON.stringify(lockInfo));
    return true;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }

    const raceLock = await readPidLock(pidPath);
    if (raceLock) return false;
    throw new PidLockError("Failed to acquire PID lock due to race condition");
  } finally {
    await fd?.close();
  }
}

export async function acquirePidLock(
  paseoHome: string,
  listen: string | null,
  options?: AcquirePidLockOptions,
): Promise<boolean> {
  const pidPath = getPidFilePath(paseoHome);
  const reclaimLockPath = join(paseoHome, ".reclaim.lock");

  ensurePrivateDirectory(paseoHome);
  return withReclaimLock(reclaimLockPath, async () => {
    const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
    const bootId = currentBootId();
    const lockInfo: PidLockInfo = {
      pid: lockOwnerPid,
      startedAt: new Date().toISOString(),
      hostname: getHostName(),
      uid: process.getuid?.() ?? 0,
      listen,
      heartbeat: true,
      ...(bootId ? { bootId } : {}),
      ...(process.env.PASEO_DESKTOP_MANAGED === "1" ? { desktopManaged: true } : {}),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingLock = await readPidLock(pidPath);
      if (existingLock) {
        const result = await clearExistingPidLock(pidPath, existingLock, lockOwnerPid);
        if (result === "already_owned") return true;
        if (result === "occupied") return false;
      } else {
        await removeEmptyPidLock(pidPath);
      }

      if (await writeNewPidLock(pidPath, lockInfo)) return true;
    }

    throw new PidLockError("PID lock changed repeatedly while reclaiming it");
  });
}

export async function refreshPidLock(
  paseoHome: string,
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const reclaimLockPath = join(paseoHome, ".reclaim.lock");
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  await withReclaimLock(reclaimLockPath, async () => {
    let fd;
    try {
      fd = await open(pidPath, "r+");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new PidLockError("Cannot refresh PID lock: lock file is missing");
      }
      throw error;
    }

    try {
      const lock = await readPidLockFromHandleWithRetry(fd);
      if (!lock) {
        throw new PidLockError("Cannot refresh PID lock: invalid lock file");
      }
      if (lock.pid !== lockOwnerPid || lock.hostname !== getHostName()) {
        throw new PidLockError(`Cannot refresh PID lock owned by PID ${lock.pid}`, lock);
      }
      const now = new Date();
      await fd.utimes(now, now);
    } finally {
      await fd.close();
    }
  });
}

async function readPidLockFromHandle(fd: FileHandle): Promise<PidLockInfo | null> {
  try {
    const { size } = await fd.stat();
    if (size === 0) {
      return null;
    }
    const content = Buffer.alloc(size);
    const { bytesRead } = await fd.read(content, 0, size, 0);
    return parsePidLockInfo(JSON.parse(content.subarray(0, bytesRead).toString("utf-8")));
  } catch {
    return null;
  }
}

async function readPidLockFromHandleWithRetry(fd: FileHandle): Promise<PidLockInfo | null> {
  for (let attempt = 0; attempt < PID_LOCK_READ_RETRY_ATTEMPTS; attempt += 1) {
    const lock = await readPidLockFromHandle(fd);
    if (lock) {
      return lock;
    }
    if (attempt < PID_LOCK_READ_RETRY_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, PID_LOCK_READ_RETRY_DELAY_MS));
    }
  }
  return null;
}

export function startPidLockHeartbeat(
  paseoHome: string,
  options?: {
    ownerPid?: number;
    intervalMs?: number;
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
  },
): () => void {
  const intervalMs = options?.intervalMs ?? PID_LOCK_HEARTBEAT_INTERVAL_MS;
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    void (async () => {
      try {
        await refreshPidLock(paseoHome, { ownerPid: options?.ownerPid });
        options?.onSuccess?.();
      } catch (error) {
        if (options?.onError) {
          options.onError(error);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
        }
      } finally {
        refreshing = false;
      }
    })();
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

export async function updatePidLock(
  paseoHome: string,
  patch: { listen: string; serverId: string } | { listen: null; serverId: null },
  options?: { ownerPid?: number },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  const fd = await open(pidPath, "r+");
  try {
    const existingLock = await readPidLockFromHandleWithRetry(fd);
    if (!existingLock) {
      throw new PidLockError("Cannot update PID lock: invalid lock file");
    }
    if (existingLock.pid !== lockOwnerPid || existingLock.hostname !== getHostName()) {
      return;
    }

    const updatedLock: PidLockInfo = {
      ...existingLock,
      ...patch,
    };
    await fd.truncate(0);
    await fd.writeFile(JSON.stringify(updatedLock));
  } finally {
    await fd.close();
  }
}

export async function releasePidLock(
  paseoHome: string,
  options?: { ownerPid?: number; startedAt?: string },
): Promise<void> {
  const pidPath = getPidFilePath(paseoHome);
  const reclaimLockPath = join(paseoHome, ".reclaim.lock");
  const lockOwnerPid = resolveOwnerPid(options?.ownerPid);
  await withReclaimLock(reclaimLockPath, async () => {
    try {
      const content = await readFile(pidPath, "utf-8");
      const lock = parsePidLockInfo(JSON.parse(content));
      if (
        lock?.hostname === getHostName() &&
        lock.pid === lockOwnerPid &&
        (options?.startedAt === undefined || lock.startedAt === options.startedAt)
      ) {
        await unlink(pidPath);
      }
    } catch {
      // The lock may already be gone or unreadable; release remains best-effort.
    }
  });
}

export async function getPidLockInfo(paseoHome: string): Promise<PidLockInfo | null> {
  const pidPath = getPidFilePath(paseoHome);
  return readPidLock(pidPath);
}

export async function isLocked(
  paseoHome: string,
): Promise<{ locked: boolean; info?: PidLockInfo }> {
  const info = await getPidLockInfo(paseoHome);
  if (!info) return { locked: false };
  // The pid owner may release between the read and this stat; a vanished
  // file means the lock no longer exists, not an error.
  const lockStat = await stat(getPidFilePath(paseoHome)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (lockStat === null) return { locked: false, info };
  if (Date.now() - lockStat.mtimeMs > PID_LOCK_STALE_AFTER_MS || !isPidLockOwnerRunning(info)) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
