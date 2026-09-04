import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveAtomicWritePathSync, type AtomicFileWriteOptions } from "./atomic-file.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function applyPrivateMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are not portable; creation must still work on such filesystems.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyPrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicFileWriteOptions & { ensurePrivateParent?: boolean } = {},
): void {
  const writePath = resolveAtomicWritePathSync(filePath, options.preserveSymlink ?? false);
  if (options.ensurePrivateParent !== false && writePath === filePath) {
    ensurePrivateDirectory(path.dirname(writePath));
  }
  const parent = path.dirname(writePath);
  const temporary = path.join(
    parent,
    `.${path.basename(writePath)}.${process.pid}.${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, writePath);
    ensurePrivateFile(writePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
