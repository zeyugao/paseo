import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory } from "./private-files.js";
import { withReclaimLock } from "./pid-lock.js";
import {
  normalizeLoopbackToLocalhost,
  parseConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";

const FILE_NAME = "local-credential";

export interface LocalCredentialWriteOptions {
  serverId?: string;
  mirrorLegacy?: boolean;
}

export interface LocalCredentialDeleteOptions {
  serverId?: string;
  token?: string;
  deleteLegacy?: boolean;
}

function credentialPath(home: string, serverId?: string): string {
  return serverId ? join(home, "daemons", serverId, FILE_NAME) : join(home, FILE_NAME);
}

async function writeCredentialFile(filePath: string, token: string): Promise<void> {
  ensurePrivateDirectory(dirname(filePath));
  const reclaimLockPath = join(dirname(filePath), ".reclaim.lock");
  await withReclaimLock(reclaimLockPath, async () => {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });
}

export async function writeLocalCredential(
  home: string,
  options: LocalCredentialWriteOptions = {},
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const instancePath = credentialPath(home, options.serverId);
  await writeCredentialFile(instancePath, token);
  if (options.serverId && options.mirrorLegacy === true) {
    try {
      await writeCredentialFile(credentialPath(home), token);
    } catch (error) {
      await deleteCredentialIfOwned(instancePath, token);
      throw error;
    }
  }
  return token;
}

async function deleteCredentialIfOwned(filePath: string, token: string | undefined): Promise<void> {
  const reclaimLockPath = join(dirname(filePath), ".reclaim.lock");
  await withReclaimLock(reclaimLockPath, async () => {
    try {
      if (token !== undefined && (await readFile(filePath, "utf8")).trim() !== token) return;
      await unlink(filePath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  });
}

export async function deleteLocalCredential(
  home: string,
  options: LocalCredentialDeleteOptions = {},
): Promise<void> {
  await deleteCredentialIfOwned(credentialPath(home, options.serverId), options.token);
  if (options.serverId && options.deleteLegacy === true) {
    await deleteCredentialIfOwned(credentialPath(home), options.token);
  }
}

export function readLocalCredential(home: string): string | null {
  try {
    const token = readFileSync(join(home, FILE_NAME), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function matchesLocalCredential(expected: string, candidate: string): boolean {
  const actual = Buffer.from(candidate);
  const reference = Buffer.from(expected);
  return actual.length === reference.length && timingSafeEqual(actual, reference);
}

function normalizeTarget(target: string): string | null {
  try {
    const trimmed = target.trim();
    if (trimmed.startsWith("tcp://")) {
      const parsed = parseConnectionUri(trimmed);
      const endpoint = parsed.isIpv6
        ? `[${parsed.host}]:${parsed.port}`
        : `${parsed.host}:${parsed.port}`;
      return normalizeLoopbackToLocalhost(endpoint);
    }
    if (trimmed.startsWith("unix://") || trimmed.startsWith("pipe://")) return trimmed;
    if (trimmed.startsWith("/")) return `unix://${trimmed}`;
    if (trimmed.startsWith("\\\\.\\pipe\\")) return `pipe://${trimmed}`;
    if (/^\d+$/.test(trimmed)) return `localhost:${trimmed}`;
    return normalizeLoopbackToLocalhost(trimmed);
  } catch {
    return null;
  }
}

export function readLocalCredentialForTarget(home: string, target: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as {
      listen?: unknown;
    };
    if (typeof lock.listen !== "string") return null;
    const selected = normalizeTarget(target);
    const listening = normalizeTarget(lock.listen);
    if (!selected || !listening || selected !== listening) return null;
    return readLocalCredential(home);
  } catch {
    return null;
  }
}
