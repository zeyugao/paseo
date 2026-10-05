import { readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type pino from "pino";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  type KeyPair,
} from "@getpaseo/relay/e2ee";
import { ensurePrivateDirectory, ensurePrivateFile, PRIVATE_FILE_MODE } from "./private-files.js";
import { withReclaimLock } from "./pid-lock.js";

const KeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

export interface DaemonKeyPairBundle {
  keyPair: KeyPair;
  publicKeyB64: string;
}

export interface LoadDaemonKeyPairOptions {
  serverId?: string;
  logger?: pino.Logger;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function loadStoredKeyPair(filePath: string): Promise<DaemonKeyPairBundle> {
  ensurePrivateFile(filePath);
  const parsed = KeyPairSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  const publicKey = importPublicKey(parsed.publicKeyB64);
  const secretKey = importSecretKey(parsed.secretKeyB64);
  return {
    keyPair: { publicKey, secretKey },
    publicKeyB64: exportPublicKey(publicKey),
  };
}

function serializeKeyPair(bundle: DaemonKeyPairBundle): string {
  const payload: StoredKeyPair = {
    v: 2,
    publicKeyB64: bundle.publicKeyB64,
    secretKeyB64: exportSecretKey(bundle.keyPair.secretKey),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function createKeyPairExclusive(
  filePath: string,
  bundle: DaemonKeyPairBundle,
): Promise<boolean> {
  ensurePrivateDirectory(path.dirname(filePath));
  try {
    await writeFile(filePath, serializeKeyPair(bundle), { flag: "wx", mode: PRIVATE_FILE_MODE });
    ensurePrivateFile(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return false;
    throw error;
  }
}

async function loadKeyPairWinner(filePath: string): Promise<DaemonKeyPairBundle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await loadStoredKeyPair(filePath);
    } catch (error) {
      lastError = error;
      if (attempt < 9) await delay(50);
    }
  }
  throw lastError;
}

/**
 * Adopts the legacy single-machine keypair when this daemon's serverId is the one the
 * legacy `server-id` file names; every other serverId generates its own identity.
 * Returns null when adoption does not apply, so the caller falls through to creation.
 */
async function adoptLegacyDaemonKeyPair(
  paseoHome: string,
  filePath: string,
  legacyPath: string,
  serverId: string,
  log?: pino.Logger,
): Promise<DaemonKeyPairBundle | null> {
  try {
    const persistedServerId = readFileSync(path.join(paseoHome, "server-id"), "utf8").trim();
    if (persistedServerId !== serverId) return null;
    const adopted = await loadStoredKeyPair(legacyPath);
    if (await createKeyPairExclusive(filePath, adopted)) {
      log?.info({ filePath, legacyPath }, "Adopted legacy daemon keypair");
      return adopted;
    }
    const winner = await loadKeyPairWinner(filePath);
    log?.info({ filePath }, "Loaded concurrently created daemon keypair");
    return winner;
  } catch (error) {
    log?.warn({ err: error, legacyPath }, "Failed to adopt legacy daemon keypair, regenerating");
    return null;
  }
}

export async function loadOrCreateDaemonKeyPair(
  paseoHome: string,
  options: LoadDaemonKeyPairOptions = {},
): Promise<DaemonKeyPairBundle> {
  const log = options.logger?.child({ module: "daemon-keypair" });
  const legacyPath = path.join(paseoHome, KEYPAIR_FILENAME);
  const filePath = options.serverId
    ? path.join(paseoHome, "daemons", options.serverId, KEYPAIR_FILENAME)
    : legacyPath;

  let targetMissing = false;
  try {
    const loaded = await loadStoredKeyPair(filePath);
    log?.info({ filePath }, "Loaded daemon keypair");
    return loaded;
  } catch (error) {
    targetMissing = isErrnoException(error) && error.code === "ENOENT";
    if (!targetMissing) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  if (targetMissing && options.serverId) {
    const adopted = await adoptLegacyDaemonKeyPair(
      paseoHome,
      filePath,
      legacyPath,
      options.serverId,
      log,
    );
    if (adopted) return adopted;
  }

  const reclaimLockPath = path.join(path.dirname(filePath), ".reclaim.lock");
  return withReclaimLock(reclaimLockPath, async () => {
    try {
      const winner = await loadStoredKeyPair(filePath);
      log?.info({ filePath }, "Loaded daemon keypair regenerated concurrently");
      return winner;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        // The exclusive create below handles the first writer.
      } else {
        try {
          await unlink(filePath);
        } catch (unlinkError) {
          if (!isErrnoException(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError;
        }
      }
    }

    const keyPair = generateKeyPair();
    const created = { keyPair, publicKeyB64: exportPublicKey(keyPair.publicKey) };
    if (await createKeyPairExclusive(filePath, created)) {
      log?.info(
        { filePath },
        targetMissing ? "Saved daemon keypair" : "Regenerated daemon keypair",
      );
      return created;
    }

    const winner = await loadKeyPairWinner(filePath);
    log?.info({ filePath }, "Loaded concurrently created daemon keypair");
    return winner;
  });
}
