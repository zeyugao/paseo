import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export interface AtomicFileWriteOptions {
  preserveSymlink?: boolean;
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
    await fs.rename(tempPath, writePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
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
