import type pino from "pino";
import { readFile } from "node:fs/promises";

import { ensurePrivateFileAsync, writePrivateFileAtomicSync } from "../private-files.js";
import { withReclaimLock } from "../pid-lock.js";

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
  }

  async renewToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    await withReclaimLock(`${this.filePath}.lock`, async () => {
      const { subscriptions, needsMigration } = await this.loadFromDisk();
      const now = this.now();
      const currentExpiry = subscriptions.get(normalized);
      if (currentExpiry === undefined || currentExpiry - now <= this.leaseMs / 2) {
        subscriptions.set(normalized, now + this.leaseMs);
      } else if (!needsMigration) {
        return;
      }
      this.persist(subscriptions);
      this.logger.debug({ total: subscriptions.size }, "Renewed token");
    });
  }

  async revokeToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    await withReclaimLock(`${this.filePath}.lock`, async () => {
      const { subscriptions, needsMigration } = await this.loadFromDisk();
      if (!subscriptions.delete(normalized) && !needsMigration) return;
      this.persist(subscriptions);
      this.logger.debug({ total: subscriptions.size }, "Revoked token");
    });
  }

  async getActiveTokens(): Promise<string[]> {
    return withReclaimLock(`${this.filePath}.lock`, async () => {
      const { subscriptions, needsMigration } = await this.loadFromDisk();
      const now = this.now();
      let needsPruning = false;
      for (const [token, expiresAt] of subscriptions) {
        if (expiresAt <= now) {
          subscriptions.delete(token);
          needsPruning = true;
        }
      }
      if (needsPruning || needsMigration) {
        try {
          this.persist(subscriptions);
        } catch {
          // Expired tokens stay excluded from delivery; the next read reloads
          // authoritative disk state and retries pruning under the same lock.
        }
      }
      return Array.from(subscriptions.keys());
    });
  }

  private async loadFromDisk(): Promise<{
    subscriptions: Map<string, number>;
    needsMigration: boolean;
  }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { subscriptions: new Map(), needsMigration: false };
      }
      this.logger.warn({ err: error }, "Failed to load push tokens");
      throw error;
    }
    await ensurePrivateFileAsync(this.filePath);
    try {
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const loaded = new Map<string, number>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as { token?: unknown; expiresAt?: unknown };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && Number.isFinite(expiresAt)) {
          loaded.set(token, expiresAt);
        }
      }

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      const expiresAt = this.now() + this.leaseMs;
      for (const token of legacyTokens) {
        const normalized = token.trim();
        if (normalized) loaded.set(normalized, expiresAt);
      }
      this.logger.debug({ total: loaded.size }, "Loaded push tokens");
      return { subscriptions: loaded, needsMigration: legacyTokens.length > 0 };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
      return { subscriptions: new Map(), needsMigration: false };
    }
  }

  private persist(subscriptions: ReadonlyMap<string, number>): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(subscriptions, ([token, expiresAt]) => ({
              token,
              expiresAt: new Date(expiresAt).toISOString(),
            })),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload, { preserveSymlink: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}
