import { readdir, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync, writePrivateFileAtomic } from "../server/private-files.js";
import { currentBootId, writtenDuringThisBoot } from "../server/pid-lock.js";
import { readServerId, validateEnvironmentServerId } from "../server/server-id.js";
import { getMachineId } from "../server/machine-id.js";
import {
  createTerminalWorkerProcessInspector,
  readTerminalWorkerServerId,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import { classifyTerminalWorkerProcess } from "./terminal-worker-ownership.js";

// Owner-only metadata used to find and authenticate workers in the locked home.

const TerminalWorkerTerminalEntrySchema = z.object({
  id: z.string().min(1),
  pid: z.number().int().positive(),
  // Null when the program's birth time could not be read: it is never signaled.
  startedAt: z.string().min(1).nullable(),
});

// The birth time and command line workers up to 0.15.1 recorded about themselves. Still read
// from their records, never written, and never consulted: the socket identifies a worker.
const LegacyTerminalWorkerIdentitySchema = z.object({
  startedAt: z.string().min(1),
  commandLine: z.string().min(1),
});

// One process a cleanup could not confirm gone, kept so a later caller (a retry, or a remote
// client reading daemon status) can name it.
const TerminalCleanupUnresolvedSchema = z.object({
  pid: z.number().int().positive(),
  role: z.enum(["worker", "terminal program"]),
  reason: z.enum(["still alive", "inspection failed"]),
  detail: z.string(),
});

const TerminalWorkerRecordSchema = z.object({
  recordId: z.string().min(1),
  pid: z.number().int().positive(),
  bootId: z.string().nullable(),
  createdAt: z.string().min(1),
  identity: LegacyTerminalWorkerIdentitySchema.optional(),
  // Read loosely: a version this daemon cannot interpret marks a worker from a newer Paseo
  // (classifyTerminalWorkerProtocol), not an unreadable record.
  protocolVersion: z.union([z.number(), z.string()]),
  paseoVersion: z.string(),
  socketPath: z.string().min(1),
  secret: z.string().min(1),
  // The copy of the worker's files it runs from (a directory name under terminal-worker/), or
  // null when it runs from source. A copy named by any record is never deleted.
  runtime: z.string().nullable().optional(),
  terminals: z.array(TerminalWorkerTerminalEntrySchema),
  // Set only in a cleanup record (below), with what a cleanup could not confirm gone. A record
  // marked closing is never adopted: the next daemon or stop retries the cleanup instead.
  closing: z.object({ unresolved: z.array(TerminalCleanupUnresolvedSchema).min(1) }).optional(),
});

export type TerminalWorkerTerminalEntry = z.infer<typeof TerminalWorkerTerminalEntrySchema>;
export type TerminalCleanupUnresolved = z.infer<typeof TerminalCleanupUnresolvedSchema>;
export type TerminalWorkerRecord = z.infer<typeof TerminalWorkerRecordSchema>;

// A worker record (`<pid>.json`) belongs to the worker, which rewrites it from memory whenever
// a terminal starts or exits. A cleanup that cannot confirm every process gone therefore keeps
// its state in a cleanup record of its own (`closing-<recordId>.json`) that no worker writes, so
// the kill intent and what it could not confirm survive any later worker rewrite.
type TerminalWorkerRecordKind = "worker" | "cleanup";

export type TerminalWorkerRecordFile =
  | {
      // The file holding this record's state: the cleanup record when there is one.
      path: string;
      record: TerminalWorkerRecord;
      // The worker's own record file, when it still exists.
      workerRecordPath: string | null;
      legacyOwnershipPath?: string;
    }
  | { path: string; error: Error };

interface TerminalWorkerRecordEntry {
  path: string;
  record: TerminalWorkerRecord;
  legacyOwnershipPath?: string;
}

interface TerminalWorkerRecordCollection {
  workers: TerminalWorkerRecordEntry[];
  cleanups: TerminalWorkerRecordEntry[];
  errors: TerminalWorkerRecordFile[];
}

interface LegacyWorkerOwnershipContext {
  directory: string;
  serverId: string;
  machineId: string;
  inspector: TerminalWorkerProcessInspector;
}

// The worker's command line carries this marker followed by its record id, so a reused pid
// running some other process (even another worker) never matches the record.
export const TERMINAL_WORKER_MARKER_ARG = "--paseo-terminal-worker";

/** Worker state home only: never use this as the shell's PASEO_HOME. */
export function terminalWorkerHome(paseoHome: string, serverId: string): string {
  if (!serverId) throw new Error("Terminal worker requires a serverId");
  return path.join(paseoHome, "daemons", validateEnvironmentServerId(serverId));
}

export function terminalWorkerDirectory(paseoHome: string): string {
  return path.join(paseoHome, "terminal-worker");
}

export function terminalWorkerRecordPath(paseoHome: string, workerPid: number): string {
  return path.join(terminalWorkerDirectory(paseoHome), `${workerPid}.json`);
}

export function terminalCleanupRecordPath(paseoHome: string, recordId: string): string {
  return path.join(terminalWorkerDirectory(paseoHome), `closing-${recordId}.json`);
}

export function terminalWorkerLogPath(paseoHome: string): string {
  return path.join(paseoHome, "terminal-worker.log");
}

export function writeTerminalWorkerRecord(paseoHome: string, record: TerminalWorkerRecord): string {
  const recordPath = terminalWorkerRecordPath(paseoHome, record.pid);
  writePrivateFileAtomicSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

/** Writes the state of a cleanup that could not confirm every process gone. */
export async function writeTerminalCleanupRecord(
  paseoHome: string,
  record: TerminalWorkerRecord & { closing: NonNullable<TerminalWorkerRecord["closing"]> },
): Promise<string> {
  if (!RECORD_ID_PATTERN.test(record.recordId)) {
    throw new Error(`Terminal worker record id is not a file name: ${record.recordId}`);
  }
  const recordPath = terminalCleanupRecordPath(paseoHome, record.recordId);
  await writePrivateFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

export async function readTerminalWorkerRecord(recordPath: string): Promise<TerminalWorkerRecord> {
  return TerminalWorkerRecordSchema.parse(JSON.parse(await readRecordFile(recordPath)));
}

// A worker rewrites its record by renaming a new file over it. On Windows an open() that races
// that rename fails with EPERM (or EBUSY) for a moment, so such an error is retried for a short
// window before the record counts as unreadable. Reads and retries yield so daemon status and
// cleanup never block unrelated requests while another process holds the record open.
const TRANSIENT_READ_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const TRANSIENT_READ_WINDOW_MS = 250;
const TRANSIENT_READ_PAUSE_MS = 10;

async function readRecordFile(recordPath: string): Promise<string> {
  const deadline = Date.now() + TRANSIENT_READ_WINDOW_MS;
  for (;;) {
    try {
      return await readFile(recordPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_READ_ERRORS.has(code) || Date.now() >= deadline) throw error;
      await delay(TRANSIENT_READ_PAUSE_MS);
    }
  }
}

const RECORD_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const WORKER_RECORD_NAME = /^\d+\.json$/;
const CLEANUP_RECORD_NAME = /^closing-[A-Za-z0-9-]+\.json$/;

function recordKindOf(fileName: string): TerminalWorkerRecordKind | null {
  if (WORKER_RECORD_NAME.test(fileName)) return "worker";
  if (CLEANUP_RECORD_NAME.test(fileName)) return "cleanup";
  return null;
}

/**
 * Every record in the supplied worker state home (terminalWorkerHome for daemon callers).
 * Scoped homes also include safely attributed legacy root workers, retaining a private
 * machine-bound receipt for cleanup retries. A cleanup record merges with its worker:
 * closing state wins and newly recorded programs join it, so retries cover every program.
 */
export async function listTerminalWorkerRecords(
  paseoHome: string,
): Promise<TerminalWorkerRecordFile[]> {
  const directory = terminalWorkerDirectory(paseoHome);
  const names = await readTerminalWorkerRecordNames(directory);
  const entries = await readTerminalWorkerRecordEntries(directory, names);
  await collectLegacyTerminalWorkerRecords(paseoHome, names, entries);
  return mergeTerminalWorkerRecords(entries);
}

async function readTerminalWorkerRecordNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function readTerminalWorkerRecordEntries(
  directory: string,
  names: string[],
): Promise<TerminalWorkerRecordCollection> {
  const entries: TerminalWorkerRecordCollection = { workers: [], cleanups: [], errors: [] };
  for (const name of names.sort()) {
    const kind = recordKindOf(name);
    if (!kind) continue;
    const recordPath = path.join(directory, name);
    try {
      const record = await readTerminalWorkerRecord(recordPath);
      const target = kind === "worker" ? entries.workers : entries.cleanups;
      target.push({ path: recordPath, record });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      entries.errors.push({
        path: recordPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return entries;
}

function isCurrentLegacyWorker(record: TerminalWorkerRecord, bootId: string | null): boolean {
  return (
    writtenDuringThisBoot({ startedAt: record.createdAt, bootId: record.bootId }) &&
    record.bootId === bootId &&
    RECORD_ID_PATTERN.test(record.recordId)
  );
}

// Old workers still rewrite their root record. Attribute them only to the original home
// identity and local machine; foreign, old-boot and otherwise ambiguous state stays untouched.
async function collectLegacyTerminalWorkerRecords(
  paseoHome: string,
  names: string[],
  entries: TerminalWorkerRecordCollection,
): Promise<void> {
  const instances = path.dirname(paseoHome);
  if (path.basename(instances) !== "daemons") return;
  const root = path.dirname(instances);
  const serverId = path.basename(paseoHome);
  if (readServerId(root, {}) !== serverId) return;
  const bootId = currentBootId();
  const directory = terminalWorkerDirectory(paseoHome);
  const legacyFiles = await listTerminalWorkerRecords(root);
  let context: LegacyWorkerOwnershipContext | null = null;
  for (const file of legacyFiles) {
    if (!("record" in file) || !isCurrentLegacyWorker(file.record, bootId)) continue;
    context ??= {
      directory,
      serverId,
      machineId: await getMachineId(),
      inspector: createTerminalWorkerProcessInspector(),
    };
    const legacyOwnershipPath = await preserveLegacyWorkerOwnership(file.record, context);
    if (!legacyOwnershipPath) continue;
    // Merge a scoped cleanup intent with the legacy worker it belongs to, too.
    if (file.path !== file.workerRecordPath)
      entries.cleanups.push({ ...file, legacyOwnershipPath });
    if (file.workerRecordPath) {
      entries.workers.push({
        path: file.workerRecordPath,
        record: file.record,
        legacyOwnershipPath,
      });
    }
  }
  await retireLegacyOwnershipReceipts(directory, names, legacyFiles);
}

async function isLocallyOwnedLegacyWorker(
  record: TerminalWorkerRecord,
  context: LegacyWorkerOwnershipContext,
): Promise<boolean> {
  const firstInspection = await context.inspector.inspect(record.pid);
  if (classifyTerminalWorkerProcess(record, firstInspection).status !== "owned") return false;
  let override: string | null;
  try {
    override = await readTerminalWorkerServerId(record.pid);
  } catch {
    return false; // No inspectable environment means ownership remains ambiguous.
  }
  if (override !== null && override !== context.serverId) return false;
  const lastInspection = await context.inspector.inspect(record.pid);
  return classifyTerminalWorkerProcess(record, lastInspection).status === "owned";
}

async function preserveLegacyWorkerOwnership(
  record: TerminalWorkerRecord,
  context: LegacyWorkerOwnershipContext,
): Promise<string | null> {
  const ownershipPath = path.join(context.directory, `legacy-owner-${record.recordId}.json`);
  const proof = `${JSON.stringify({
    machineId: context.machineId,
    recordId: record.recordId,
    pid: record.pid,
    startedAt: record.identity.startedAt,
  })}\n`;
  const recorded = await readRecordFile(ownershipPath).catch(() => null);
  if (recorded === proof) return ownershipPath;
  if (!(await isLocallyOwnedLegacyWorker(record, context))) return null;
  // Preserve the proven owner for retries after the legacy worker dies.
  await writePrivateFileAtomic(ownershipPath, proof);
  return ownershipPath;
}

async function retireLegacyOwnershipReceipts(
  directory: string,
  names: string[],
  legacyFiles: TerminalWorkerRecordFile[],
): Promise<void> {
  if (legacyFiles.some((file) => "error" in file)) return;
  const retained = new Set(
    legacyFiles.flatMap((file) => ("record" in file ? [file.record.recordId] : [])),
  );
  // An old worker deletes its root record on exit, but cannot remove our scoped receipt.
  for (const name of names) {
    const receipt = /^legacy-owner-([A-Za-z0-9-]+)\.json$/.exec(name);
    if (!receipt || retained.has(receipt[1]!)) continue;
    await rm(path.join(directory, name), { force: true });
  }
}

function mergeTerminalWorkerRecords(
  entries: TerminalWorkerRecordCollection,
): TerminalWorkerRecordFile[] {
  const files: TerminalWorkerRecordFile[] = [];
  const merged = new Set<string>();
  for (const cleanup of entries.cleanups) {
    const worker = entries.workers.find(
      (entry) =>
        entry.record.recordId === cleanup.record.recordId &&
        entry.record.pid === cleanup.record.pid,
    );
    if (worker) merged.add(worker.path);
    const known = new Set(cleanup.record.terminals.map((entry) => `${entry.id}:${entry.pid}`));
    const added = (worker?.record.terminals ?? []).filter(
      (entry) => !known.has(`${entry.id}:${entry.pid}`),
    );
    files.push({
      path: cleanup.path,
      record: { ...cleanup.record, terminals: [...cleanup.record.terminals, ...added] },
      workerRecordPath: worker?.path ?? null,
      ...(cleanup.legacyOwnershipPath ? { legacyOwnershipPath: cleanup.legacyOwnershipPath } : {}),
    });
  }
  for (const worker of entries.workers) {
    if (merged.has(worker.path)) continue;
    files.push({ ...worker, workerRecordPath: worker.path });
  }
  return [...files, ...entries.errors];
}

/**
 * Deletes a record, the worker's own record file and the socket it names, unless a later worker
 * that reused the pid wrote that file since. The pipe namespace on Windows needs no unlink.
 */
export async function retireTerminalWorkerRecord(file: {
  path: string;
  record: TerminalWorkerRecord;
  workerRecordPath: string | null;
  legacyOwnershipPath?: string;
}): Promise<void> {
  if (file.path !== file.workerRecordPath) await rm(file.path, { force: true });
  if (file.workerRecordPath) {
    if (await workerRecordNamesAnother(file.workerRecordPath, file.record.recordId)) return;
    await rm(file.workerRecordPath, { force: true });
  }
  if (process.platform !== "win32") {
    await rm(file.record.socketPath, { force: true });
  }
  if (file.legacyOwnershipPath) await rm(file.legacyOwnershipPath, { force: true });
}

// True when the file now belongs to another worker, or cannot be read to tell.
async function workerRecordNamesAnother(recordPath: string, recordId: string): Promise<boolean> {
  try {
    return (await readTerminalWorkerRecord(recordPath)).recordId !== recordId;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
