import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const FALLBACK_MACHINE_ID_PATH = join(homedir(), ".paseo-machine-id");
const FALLBACK_READ_ATTEMPTS = 10;
const FALLBACK_READ_DELAY_MS = 50;

let cachedMachineId: Promise<string> | undefined;

function normalizeMachineId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function readLinuxMachineId(): Promise<string | null> {
  try {
    return normalizeMachineId(await readFile("/etc/machine-id", "utf8"));
  } catch {
    return null;
  }
}

async function readMacMachineId(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertService"]);
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return match ? normalizeMachineId(match[1]) : null;
  } catch {
    return null;
  }
}

async function readFallbackMachineId(): Promise<string | null> {
  try {
    return normalizeMachineId(await readFile(FALLBACK_MACHINE_ID_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function loadFallbackMachineIdWinner(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FALLBACK_READ_ATTEMPTS; attempt += 1) {
    try {
      const winner = normalizeMachineId(await readFile(FALLBACK_MACHINE_ID_PATH, "utf8"));
      if (winner) return winner;
      lastError = new Error(`Machine identity file is empty at ${FALLBACK_MACHINE_ID_PATH}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < FALLBACK_READ_ATTEMPTS - 1) await delay(FALLBACK_READ_DELAY_MS);
  }
  throw new Error(`Cannot read machine identity at ${FALLBACK_MACHINE_ID_PATH}`, {
    cause: lastError,
  });
}

async function createFallbackMachineId(): Promise<string> {
  const existing = await readFallbackMachineId();
  if (existing) return existing;

  const generated = `${hostname()}:${randomUUID()}`;
  try {
    await writeFile(FALLBACK_MACHINE_ID_PATH, `${generated}\n`, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return loadFallbackMachineIdWinner();
  }
}

async function loadMachineId(): Promise<string> {
  if (process.platform === "linux") {
    return (await readLinuxMachineId()) ?? createFallbackMachineId();
  }
  if (process.platform === "darwin") {
    return (await readMacMachineId()) ?? createFallbackMachineId();
  }
  return createFallbackMachineId();
}

export function getMachineId(): Promise<string> {
  cachedMachineId ??= loadMachineId();
  return cachedMachineId;
}
