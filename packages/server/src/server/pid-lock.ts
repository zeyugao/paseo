import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, stat, unlink, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "./private-files.js";
import { dirname, join, resolve as resolvePath } from "node:path";
import { uptime } from "node:os";
import { getHostName } from "./host-name.js";
import { z } from "zod";
import { getMachineId, readMachineId } from "./machine-id.js";
import { createTerminalWorkerProcessInspector } from "../terminal/terminal-worker-processes.js";

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
  processStartedAt: z.string().optional(),
  machineId: z.string().optional(),
});

export interface PidLockInfo extends z.infer<typeof pidLockInfoSchema> {}

function parsePidLockInfo(raw: unknown): PidLockInfo | null {
  const result = pidLockInfoSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// The field is assigned explicitly rather than declared as a constructor parameter property:
// the terminal worker loads this module under --experimental-strip-types, which cannot emit
// the assignment a parameter property implies.
export class PidLockError extends Error {
  readonly existingLock?: PidLockInfo;

  constructor(message: string, existingLock?: PidLockInfo) {
    super(message);
    this.name = "PidLockError";
    this.existingLock = existingLock;
  }
}

const PID_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const PID_LOCK_READ_RETRY_ATTEMPTS = 10;
const PID_LOCK_READ_RETRY_DELAY_MS = 50;
export const PID_LOCK_STALE_AFTER_MS = 120_000;

const RECLAIM_LOCK_HOLDER = 'printf "\\001"; cat >/dev/null';
// The lock path is base64-encoded to survive PowerShell's -Command argument
// parsing, which breaks on paths containing spaces.
const WINDOWS_RECLAIM_LOCK_HOLDER =
  "$ErrorActionPreference = 'Stop'; try { $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($args[0])); $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::Out.Write([char]1); [Console]::Out.Flush(); [Console]::In.ReadToEnd() | Out-Null } finally { $stream.Dispose() } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
const SYNC_RECLAIM_LOCK_HOLDER =
  'printf "\\001" > "$1"; while [ ! -e "$3" ]; do sleep 0.01; done; printf "\\001" > "$2"';
const SYNC_RECLAIM_LOCK_TIMEOUT_MS = 30_000;
const SYNC_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function waitForLockMarker(markerPath: string, deadline: number, description: string): void {
  while (!existsSync(markerPath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out ${description}`);
    Atomics.wait(SYNC_LOCK_SLEEP, 0, 0, 10);
  }
}

export function withReclaimLockSync<T>(lockPath: string, action: () => T): T {
  // Windows has no flock; the shared-home feature requires NFS-class storage
  // with cross-client flock semantics, which Windows does not provide. The
  // sync lock is only used for same-process plugin config patches, so a
  // no-op is correct on this platform.
  if (process.platform === "win32") {
    return action();
  }
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
  if (process.platform === "darwin") {
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

export interface ReclaimLockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ReclaimLockQueueFullError extends Error {
  readonly lockPath: string;
  readonly maxPending = 64;

  constructor(lockPath: string) {
    super(`Reclaim lock queue for ${lockPath} already has 64 pending acquisitions`);
    this.name = "ReclaimLockQueueFullError";
    this.lockPath = lockPath;
  }
}

export class ReclaimLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out acquiring reclaim lock ${lockPath} after ${timeoutMs}ms`);
    this.name = "ReclaimLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  // The server targets ES2023, before Promise.withResolvers became available.
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface ReclaimLockWaiter {
  run(): Promise<void>;
}

interface ReclaimLockQueue {
  pending: ReclaimLockWaiter[];
}

const reclaimLockQueues = new Map<string, ReclaimLockQueue>();
const RECLAIM_LOCK_ACQUISITION_TIMEOUT_MS = 30_000;
const RECLAIM_LOCK_MAX_PENDING = 64;
const RECLAIM_LOCK_RELEASE_GRACE_MS = 1_000;

async function runReclaimLockWaiter(
  lockPath: string,
  queue: ReclaimLockQueue,
  waiter: ReclaimLockWaiter,
): Promise<void> {
  await waiter.run();
  const next = queue.pending.shift();
  if (next) {
    void runReclaimLockWaiter(lockPath, queue, next);
  } else {
    reclaimLockQueues.delete(lockPath);
  }
}

export function withReclaimLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: ReclaimLockOptions = {},
): Promise<T> {
  const absolutePath = resolvePath(lockPath);
  const timeoutMs = options.timeoutMs ?? RECLAIM_LOCK_ACQUISITION_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(
      new RangeError("Reclaim lock timeoutMs must be between 0 and 2147483647"),
    );
  }
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  if (timeoutMs === 0) return Promise.reject(new ReclaimLockTimeoutError(absolutePath, timeoutMs));
  const existingQueue = reclaimLockQueues.get(absolutePath);
  if (existingQueue && existingQueue.pending.length >= RECLAIM_LOCK_MAX_PENDING) {
    return Promise.reject(new ReclaimLockQueueFullError(absolutePath));
  }

  const queue: ReclaimLockQueue = existingQueue ?? { pending: [] };
  const cancellation = new AbortController();
  const result = createDeferred<T>();
  function finishAcquisition(): void {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
  function cancel(reason: unknown): void {
    finishAcquisition();
    cancellation.abort(reason);
    const index = queue.pending.indexOf(waiter);
    if (index !== -1) queue.pending.splice(index, 1);
    result.reject(reason);
  }
  function abort(): void {
    cancel(options.signal?.reason);
  }
  function check(): void {
    cancellation.signal.throwIfAborted();
    if (performance.now() >= deadline) {
      throw new ReclaimLockTimeoutError(absolutePath, timeoutMs);
    }
  }
  function acquired(): void {
    check();
    finishAcquisition();
  }
  const timer = setTimeout(
    () => cancel(new ReclaimLockTimeoutError(absolutePath, timeoutMs)),
    timeoutMs,
  );
  const waiter: ReclaimLockWaiter = {
    async run() {
      try {
        result.resolve(
          await runWithReclaimLock(absolutePath, action, {
            signal: cancellation.signal,
            check,
            acquired,
            deadline,
            timeoutMs,
          }),
        );
      } catch (error) {
        result.reject(error);
      } finally {
        finishAcquisition();
      }
    },
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (existingQueue) {
    queue.pending.push(waiter);
  } else {
    reclaimLockQueues.set(absolutePath, queue);
    void runReclaimLockWaiter(absolutePath, queue, waiter);
  }
  return result.promise;
}

interface ReclaimLockAcquisition {
  signal: AbortSignal;
  deadline: number;
  timeoutMs: number;
  check(): void;
  acquired(): void;
}

async function runWithReclaimLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  acquisition: ReclaimLockAcquisition,
): Promise<T> {
  const { signal } = acquisition;
  acquisition.check();
  ensurePrivateDirectory(dirname(lockPath));
  acquisition.check();
  const lockFile = await open(lockPath, "a", PRIVATE_FILE_MODE);
  await lockFile.close();
  acquisition.check();

  let command = "flock";
  const remainingSeconds = Math.max((acquisition.deadline - performance.now()) / 1_000, 0.001);
  let args: string[] = [
    "--exclusive",
    "--timeout",
    String(remainingSeconds),
    "--conflict-exit-code",
    "75",
    lockPath,
    "/bin/sh",
    "-c",
    RECLAIM_LOCK_HOLDER,
  ];
  if (process.platform === "win32") {
    command = "powershell.exe";
    const encodedLockPath = Buffer.from(lockPath, "utf8").toString("base64");
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_RECLAIM_LOCK_HOLDER,
      encodedLockPath,
    ];
  } else if (process.platform === "darwin") {
    command = "lockf";
    args = [
      "-t",
      String(Math.ceil(remainingSeconds)),
      lockPath,
      "/bin/sh",
      "-c",
      RECLAIM_LOCK_HOLDER,
    ];
  }
  // Each POSIX helper owns a new process group, including lockf/flock's shell and cat.
  // Killing only the direct child can leave a descendant holding the lock or its pipes.
  const holder = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let spawnError: Error | undefined;
  let releasing = false;
  let actionStarted = false;
  let criticalSectionInvalidated = false;
  let cleanupError: Error | undefined;
  let stderr = "";
  const closeResult = createDeferred<void>();
  const closed = closeResult.promise;
  holder.once("close", () => closeResult.resolve());

  function terminateOwnedHolder(): void {
    if (holder.pid === undefined) return;
    try {
      if (process.platform === "win32") holder.kill("SIGKILL");
      else process.kill(-holder.pid, "SIGKILL");
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ESRCH") {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  function invalidate(reason: string): void {
    if (releasing || !actionStarted || criticalSectionInvalidated) return;
    criticalSectionInvalidated = true;
    console.warn(
      `Reclaim lock holder for ${lockPath} exited during the action (${reason}); the critical section is no longer protected`,
    );
  }

  holder.on("error", (error) => {
    spawnError = error;
    invalidate(error.message);
  });
  holder.once("exit", (code, exitSignal) => {
    invalidate(String(code ?? exitSignal));
    terminateOwnedHolder();
  });
  // A terminated reader can close stdin while release is being written.
  holder.stdin.on("error", () => {});
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });

  const acquisitionResult = createDeferred<void>();
  function abortAcquisition(): void {
    terminateOwnedHolder();
    acquisitionResult.reject(signal.reason);
  }
  function marker(chunk: Buffer): void {
    if (chunk.includes(1)) acquisitionResult.resolve();
  }
  signal.addEventListener("abort", abortAcquisition, { once: true });
  holder.stdout.on("data", marker);
  void closed.then(() => {
    if (holder.exitCode === 75 && process.platform !== "win32") {
      return acquisitionResult.reject(new ReclaimLockTimeoutError(lockPath, acquisition.timeoutMs));
    }
    return acquisitionResult.reject(
      spawnError ??
        new Error(
          `${command} exited before acquiring ${lockPath} (${holder.exitCode ?? holder.signalCode}): ${stderr.trim()}`,
        ),
    );
  });
  if (signal.aborted) abortAcquisition();
  let result!: T;
  try {
    await acquisitionResult.promise;
    signal.removeEventListener("abort", abortAcquisition);
    holder.stdout.removeListener("data", marker);
    acquisition.acquired();
    if (spawnError || holder.exitCode !== null || holder.signalCode !== null) {
      throw new Error(
        `Reclaim lock holder for ${lockPath} exited before the action began; critical section is no longer protected`,
      );
    }
    actionStarted = true;
    result = await action();
    if (criticalSectionInvalidated || holder.exitCode !== null || holder.signalCode !== null) {
      throw new Error(
        `Reclaim lock holder for ${lockPath} exited during the action; critical section is no longer protected`,
      );
    }
  } finally {
    signal.removeEventListener("abort", abortAcquisition);
    holder.stdout.removeListener("data", marker);
    releasing = true;
    if (!actionStarted || signal.aborted) terminateOwnedHolder();
    if (!holder.stdin.destroyed) holder.stdin.end();
    const releaseTimer = setTimeout(terminateOwnedHolder, RECLAIM_LOCK_RELEASE_GRACE_MS);
    await closed;
    clearTimeout(releaseTimer);
    if (
      actionStarted &&
      !criticalSectionInvalidated &&
      holder.exitCode !== 0 &&
      holder.signalCode !== "SIGKILL"
    ) {
      cleanupError =
        spawnError ??
        new Error(
          `${command} failed releasing ${lockPath} (${holder.exitCode ?? holder.signalCode}): ${stderr.trim()}`,
        );
    }
  }
  if (cleanupError) throw cleanupError;
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
export function currentBootId(): string | null {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
    } catch {
      cachedBootId = null;
    }
  }
  return cachedBootId;
}

/**
 * Whether a record stamped with `startedAt` (and, on Linux, `bootId`) was written during the
 * current boot. Daemon locks and terminal worker records share this rule.
 */
export function writtenDuringThisBoot(stamp: {
  startedAt: string;
  bootId?: string | null;
}): boolean {
  const thisBoot = currentBootId();
  if (stamp.bootId && thisBoot) return stamp.bootId === thisBoot;
  return !precedesThisBoot(stamp.startedAt);
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

async function isLocalPidLockOwnerRunning(lock: PidLockInfo): Promise<boolean> {
  if (lock.machineId && lock.machineId !== (await readMachineId())) return false;
  if (!isPidLockOwnerRunning(lock)) return false;
  if (!lock.processStartedAt) return true;
  const inspection = await createTerminalWorkerProcessInspector().inspect(lock.pid);
  if (inspection.status === "error") throw inspection.error;
  return inspection.status === "alive" && inspection.snapshot.startedAt === lock.processStartedAt;
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
    left.hostname === right.hostname &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    (!left.machineId || !right.machineId || left.machineId === right.machineId) &&
    (!left.processStartedAt ||
      !right.processStartedAt ||
      left.processStartedAt === right.processStartedAt)
  );
}

async function clearExistingPidLock(
  pidPath: string,
  existingLock: PidLockInfo,
  lockOwnerPid: number,
): Promise<"already_owned" | "occupied" | "cleared"> {
  const localHostname = getHostName();
  const sameHost = existingLock.machineId
    ? existingLock.machineId === (await readMachineId())
    : existingLock.hostname === localHostname;
  const lockOwnerRunning = await isLocalPidLockOwnerRunning(existingLock);
  if (sameHost && existingLock.pid === lockOwnerPid && lockOwnerRunning) {
    await touchPidLockFile(pidPath);
    return "already_owned";
  }
  const lockStat = await stat(pidPath);
  const stale = Date.now() - lockStat.mtimeMs > PID_LOCK_STALE_AFTER_MS;
  if (lockOwnerRunning || (!stale && !sameHost)) return "occupied";

  const confirmedLock = await readPidLock(pidPath);
  if (!confirmedLock || !isSamePidLock(existingLock, confirmedLock)) {
    return "occupied";
  }
  const confirmedStat = await stat(pidPath);
  const confirmedStale = Date.now() - confirmedStat.mtimeMs > PID_LOCK_STALE_AFTER_MS;
  if (
    (await isLocalPidLockOwnerRunning(confirmedLock)) ||
    (!confirmedStale &&
      (confirmedLock.machineId
        ? confirmedLock.machineId !== (await readMachineId())
        : confirmedLock.hostname !== localHostname))
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
    const machineId = await getMachineId();
    const inspection = await createTerminalWorkerProcessInspector().inspect(lockOwnerPid);
    if (inspection.status === "error") throw inspection.error;
    const bootId = currentBootId();
    const lockInfo: PidLockInfo = {
      pid: lockOwnerPid,
      startedAt: new Date().toISOString(),
      hostname: getHostName(),
      uid: process.getuid?.() ?? 0,
      listen,
      heartbeat: true,
      machineId,
      ...(inspection.status === "alive" && inspection.snapshot.startedAt
        ? { processStartedAt: inspection.snapshot.startedAt }
        : {}),
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
      if (
        lock.pid !== lockOwnerPid ||
        lock.hostname !== getHostName() ||
        (lock.machineId && lock.machineId !== (await readMachineId())) ||
        (lock.processStartedAt && !(await isLocalPidLockOwnerRunning(lock)))
      ) {
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
    if (
      existingLock.pid !== lockOwnerPid ||
      existingLock.hostname !== getHostName() ||
      (existingLock.machineId && existingLock.machineId !== (await readMachineId())) ||
      (existingLock.processStartedAt && !(await isLocalPidLockOwnerRunning(existingLock)))
    ) {
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
        (!lock.machineId || lock.machineId === (await readMachineId())) &&
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
  if (!(await isLocalPidLockOwnerRunning(info))) {
    return { locked: false, info };
  }
  return { locked: true, info };
}
