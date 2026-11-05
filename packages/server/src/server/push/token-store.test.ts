import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE, writePrivateFileAtomicSync } from "../private-files.js";
import { createPushNotifications } from "./index.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;
const LEASE_MS = 48 * 60 * 60 * 1000;
const INITIAL_NOW = Date.parse("2026-08-10T00:00:00.000Z");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function temporaryStorePath(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
  homes.push(home);
  return path.join(home, "push-tokens.json");
}

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("PushTokenStore file permissions", () => {
  test("persists push tokens with private permissions", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
      });

      await pushNotifications.renew("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when loading", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      const deliveries: string[][] = [];
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
        deliver: async (tokens) => deliveries.push(tokens),
      });
      await pushNotifications.send({ title: "Agent finished", body: "Done" });

      expect(deliveries).toEqual([["ExponentPushToken[test]"]]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore persistence", () => {
  test("does not apply a revocation until the updated subscriptions are durable", async () => {
    const filePath = temporaryStorePath();
    let rejectWrites = false;
    const store = new PushTokenStore(
      createLogger(),
      filePath,
      () => INITIAL_NOW,
      LEASE_MS,
      (target, payload, options) => {
        if (rejectWrites) throw new Error("disk full");
        writePrivateFileAtomicSync(target, payload, options);
      },
    );

    await store.renewToken("ExponentPushToken[test]");
    rejectWrites = true;

    await expect(store.revokeToken("ExponentPushToken[test]")).rejects.toThrow("disk full");
    expect(await store.getActiveTokens()).toEqual(["ExponentPushToken[test]"]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      subscriptions: [
        {
          token: "ExponentPushToken[test]",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });

    rejectWrites = false;
    await store.revokeToken("ExponentPushToken[test]");
    expect(await store.getActiveTokens()).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ subscriptions: [] });
  });

  test("independently loaded stores preserve sequential adds and see revocations", async () => {
    const filePath = temporaryStorePath();
    const first = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    expect(await first.getActiveTokens()).toEqual([]);
    expect(await second.getActiveTokens()).toEqual([]);

    await first.renewToken("first");
    expect(await second.getActiveTokens()).toEqual(["first"]);
    await second.renewToken("second");
    expect(await first.getActiveTokens()).toEqual(["first", "second"]);
    await second.revokeToken("first");
    expect(await first.getActiveTokens()).toEqual(["second"]);
    await first.renewToken("third");

    const restarted = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    expect(await restarted.getActiveTokens()).toEqual(["second", "third"]);
  });

  test("independent concurrent additions and revocations keep unrelated tokens", async () => {
    const filePath = temporaryStorePath();
    const first = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    await Promise.all([first.getActiveTokens(), second.getActiveTokens()]);

    await Promise.all([first.renewToken("first"), second.renewToken("second")]);
    expect((await first.getActiveTokens()).sort()).toEqual(["first", "second"]);
    await Promise.all([first.revokeToken("first"), second.renewToken("third")]);
    expect((await second.getActiveTokens()).sort()).toEqual(["second", "third"]);
    const restarted = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    expect((await restarted.getActiveTokens()).sort()).toEqual(["second", "third"]);
  });

  test("pruning does not restore revoked tokens or remove another store's renewal", async () => {
    const filePath = temporaryStorePath();
    let now = INITIAL_NOW;
    const first = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    await first.renewToken("revoked");
    await first.renewToken("renewed");
    await first.renewToken("expired");
    expect(await second.getActiveTokens()).toEqual(["revoked", "renewed", "expired"]);

    await second.revokeToken("revoked");
    now += LEASE_MS;
    await second.renewToken("renewed");
    expect(await first.getActiveTokens()).toEqual(["renewed"]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      subscriptions: [{ token: "renewed", expiresAt: "2026-08-14T00:00:00.000Z" }],
    });
  });

  test("concurrent expiry pruning and renewal leave the token registered after restart", async () => {
    const filePath = temporaryStorePath();
    let now = INITIAL_NOW;
    const first = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    await first.renewToken("renewed");
    await second.getActiveTokens();
    now += LEASE_MS;

    await Promise.all([first.getActiveTokens(), second.renewToken("renewed")]);

    expect(await first.getActiveTokens()).toEqual(["renewed"]);
    const restarted = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    expect(await restarted.getActiveTokens()).toEqual(["renewed"]);
  });

  test("failed pruning excludes expired tokens and reloads a later renewal", async () => {
    const filePath = temporaryStorePath();
    let now = INITIAL_NOW;
    let rejectWrites = false;
    const first = new PushTokenStore(
      createLogger(),
      filePath,
      () => now,
      LEASE_MS,
      (target, payload, options) => {
        if (rejectWrites) throw new Error("disk full");
        writePrivateFileAtomicSync(target, payload, options);
      },
    );
    const second = new PushTokenStore(createLogger(), filePath, () => now, LEASE_MS);
    await first.renewToken("renewed");
    const beforePruning = readFileSync(filePath, "utf8");
    now += LEASE_MS;
    rejectWrites = true;

    expect(await first.getActiveTokens()).toEqual([]);
    expect(readFileSync(filePath, "utf8")).toBe(beforePruning);
    await second.renewToken("renewed");
    expect(await first.getActiveTokens()).toEqual(["renewed"]);
  });

  test("legacy migration and independent changes preserve valid tokens", async () => {
    const filePath = temporaryStorePath();
    writeFileSync(filePath, JSON.stringify({ tokens: [" legacy ", 42, ""] }));
    const first = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);

    await Promise.all([first.getActiveTokens(), second.renewToken("new")]);
    expect((await first.getActiveTokens()).sort()).toEqual(["legacy", "new"]);
    await second.revokeToken("legacy");
    expect(await first.getActiveTokens()).toEqual(["new"]);
    const restarted = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    expect(await restarted.getActiveTokens()).toEqual(["new"]);
    expect(JSON.parse(readFileSync(filePath, "utf8")).tokens).toBeUndefined();
  });

  test("malformed content remains readable as empty and can be replaced by a registration", async () => {
    const filePath = temporaryStorePath();
    writeFileSync(filePath, "{invalid");
    const store = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    expect(await store.getActiveTokens()).toEqual([]);
    expect(readFileSync(filePath, "utf8")).toBe("{invalid");

    await store.renewToken("registered");
    expect(await store.getActiveTokens()).toEqual(["registered"]);
    writeFileSync(
      filePath,
      JSON.stringify({
        subscriptions: [
          { token: " valid ", expiresAt: "2026-08-12T00:00:00.000Z" },
          { token: "invalid-expiry", expiresAt: "invalid" },
          { token: 42, expiresAt: "2026-08-12T00:00:00.000Z" },
          null,
        ],
      }),
    );
    expect(await store.getActiveTokens()).toEqual(["valid"]);
  });

  test("unreadable disk state rejects mutations instead of replacing an unknown store", async () => {
    const filePath = temporaryStorePath();
    mkdirSync(filePath);
    const store = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);

    await expect(store.getActiveTokens()).rejects.toThrow();
    await expect(store.renewToken("registered")).rejects.toThrow();
    expect(statSync(filePath).isDirectory()).toBe(true);
  });

  test.skipIf(process.platform === "win32")("shared writes preserve a symlink target", async () => {
    const filePath = temporaryStorePath();
    const target = path.join(path.dirname(filePath), "target.json");
    writeFileSync(target, JSON.stringify({ subscriptions: [] }));
    symlinkSync(target, filePath);
    const first = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    const second = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    await Promise.all([first.renewToken("first"), second.renewToken("second")]);

    expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).subscriptions).toHaveLength(2);
    expect((await first.getActiveTokens()).sort()).toEqual(["first", "second"]);
  });

  test.skipIf(process.platform === "win32")("a dangling symlink is not replaced", async () => {
    const filePath = temporaryStorePath();
    symlinkSync(path.join(path.dirname(filePath), "missing.json"), filePath);
    const store = new PushTokenStore(createLogger(), filePath, () => INITIAL_NOW, LEASE_MS);
    await expect(store.renewToken("registered")).rejects.toThrow();
    expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
  });
});
