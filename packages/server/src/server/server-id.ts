import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { ensurePrivateDirectory, ensurePrivateFile, PRIVATE_FILE_MODE } from "./private-files.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const SERVER_ID_FILENAME = "server-id";

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "server-id" });
}

function getServerIdPath(paseoHome: string): string {
  return path.join(paseoHome, SERVER_ID_FILENAME);
}

export function validateEnvironmentServerId(serverId: string): string {
  if (/[\\/:+]/.test(serverId) || serverId.includes("..") || /\s/.test(serverId)) {
    throw new Error(
      "Invalid PASEO_SERVER_ID: it must not contain path separators, '+', ':', '..', or whitespace",
    );
  }
  return serverId;
}

function generateServerId(): string {
  // 9 bytes -> 12 base64url chars; keep it short + URL-safe.
  const rand = randomBytes(9).toString("base64url");
  return `srv_${rand}`;
}

function createServerIdExclusive(serverIdPath: string, serverId: string): boolean {
  ensurePrivateDirectory(path.dirname(serverIdPath));
  try {
    writeFileSync(serverIdPath, `${serverId}\n`, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    ensurePrivateFile(serverIdPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function readPersistedServerId(serverIdPath: string): string | null {
  ensurePrivateFile(serverIdPath);
  return readFileSync(serverIdPath, "utf8").trim() || null;
}

function readConcurrentServerIdWinner(serverIdPath: string): string {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const winner = readPersistedServerId(serverIdPath);
      if (winner) return validateEnvironmentServerId(winner);
      lastError = new Error("Concurrently created server-id file was empty");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 9) Atomics.wait(waitBuffer, 0, 0, 10);
  }
  throw lastError;
}

/**
 * Stable daemon identifier scoped to a given $PASEO_HOME.
 *
 * - Persisted to `$PASEO_HOME/server-id`
 * - Can be overridden via `PASEO_SERVER_ID` (useful for tests)
 */
export function getOrCreateServerId(
  paseoHome: string,
  options?: { env?: NodeJS.ProcessEnv; logger?: LoggerLike },
): string {
  const env = options?.env ?? process.env;
  const log = getLogger(options?.logger);
  const serverIdPath = getServerIdPath(paseoHome);

  const rawEnvOverride = env.PASEO_SERVER_ID;
  const envOverride =
    typeof rawEnvOverride === "string" && rawEnvOverride.trim().length > 0
      ? validateEnvironmentServerId(rawEnvOverride)
      : null;

  if (envOverride) {
    // Persist the override for consistent identity across restarts.
    if (!existsSync(serverIdPath)) {
      try {
        if (createServerIdExclusive(serverIdPath, envOverride)) {
          log?.info({ serverId: envOverride }, "Persisted PASEO_SERVER_ID override");
        }
      } catch (error) {
        log?.warn({ error }, "Failed to persist PASEO_SERVER_ID override");
      }
    } else {
      ensurePrivateFile(serverIdPath);
    }
    return envOverride;
  }

  if (existsSync(serverIdPath)) {
    let parsed: string | null = null;
    try {
      parsed = readPersistedServerId(serverIdPath);
    } catch (error) {
      log?.warn({ error }, "Failed to read server-id file, regenerating");
    }
    if (parsed) return validateEnvironmentServerId(parsed);
  }

  const created = generateServerId();
  let createdFile: boolean;
  try {
    createdFile = createServerIdExclusive(serverIdPath, created);
  } catch (error) {
    log?.warn({ error }, "Failed to persist serverId (continuing with in-memory id)");
    return created;
  }
  return createdFile ? created : readConcurrentServerIdWinner(serverIdPath);
}
