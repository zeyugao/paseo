import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

export interface AtomicFileWriteOptions {
  preserveSymlink?: boolean;
  /** Injectable runtime used by tests to exercise Windows replace retries. */
  operations?: AtomicFileRuntime;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Resolve only the final path component so a symlink itself is never replaced. */
export async function resolveAtomicWritePath(
  filePath: string,
  preserveSymlink = false,
): Promise<string> {
  if (!preserveSymlink) return filePath;

  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return filePath;
    throw error;
  }

  return stats.isSymbolicLink() ? await fs.realpath(filePath) : filePath;
}

/** Synchronous counterpart used by private file stores. */
export function resolveAtomicWritePathSync(filePath: string, preserveSymlink = false): string {
  if (!preserveSymlink) return filePath;

  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return filePath;
    throw error;
  }

  return stats.isSymbolicLink() ? realpathSync(filePath) : filePath;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicFileWriteOptions = {},
): Promise<void> {
  const writePath = await resolveAtomicWritePath(filePath, options.preserveSymlink ?? false);
  await fs.mkdir(path.dirname(writePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(writePath),
    `.${path.basename(writePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await replaceFile(tempPath, writePath, options.operations ?? runtime);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicFileWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), {
    ...options,
    preserveSymlink: options.preserveSymlink ?? true,
  });
}
