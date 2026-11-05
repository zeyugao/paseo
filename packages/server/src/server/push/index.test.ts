import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import {
  MockAgent,
  fetch as isolatedFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createPushNotifications } from "./index.js";

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

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device stops receiving notifications after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ subscriptions: [] });
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });

  let originalDispatcher: Dispatcher;
  let expo: MockAgent;

  beforeEach(() => {
    // Expo has no push sandbox; isolate its HTTP boundary instead of notifying real devices.
    originalDispatcher = getGlobalDispatcher();
    expo = new MockAgent();
    expo.disableNetConnect();
    setGlobalDispatcher(expo);
    // Match MockAgent's Undici version rather than Node's independently bundled fetch.
    vi.stubGlobal("fetch", isolatedFetch);
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllGlobals();
    await expo.close();
  });

  function createPersistentStore() {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    const options = {
      logger: createLogger(),
      filePath,
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
    };
    return { filePath, options, pushNotifications: createPushNotifications(options) };
  }

  test("devices from different Expo projects both receive the notification", async () => {
    const tokens = [
      "ExponentPushToken[paseo-device]",
      "ExponentPushToken[overkite-device]",
    ] as const;
    const projectByToken = new Map<string, string>([
      [tokens[0], "paseo"],
      [tokens[1], "overkite"],
    ]);
    const delivered: string[] = [];
    expo
      .get("https://exp.host")
      .intercept({ path: "/--/api/v2/push/send", method: "POST" })
      .reply(({ body }) => {
        const request = JSON.parse(String(body));
        const messages: Array<{ to: string }> = Array.isArray(request) ? request : [request];
        const projects = new Set<string | undefined>();
        const recipients: string[] = [];
        const tickets: Array<{ status: "ok" }> = [];
        for (const message of messages) {
          projects.add(projectByToken.get(message.to));
          recipients.push(message.to);
          tickets.push({ status: "ok" });
        }
        if (projects.size > 1) {
          return {
            statusCode: 400,
            data: { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] },
          };
        }
        delivered.push(...recipients);
        return { statusCode: 200, data: { data: Array.isArray(request) ? tickets : tickets[0] } };
      })
      .persist();

    const { pushNotifications } = createPersistentStore();
    for (const token of tokens) pushNotifications.renew(token);

    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(delivered.sort()).toEqual([...tokens].sort());
  });

  test.each(["DeviceNotRegistered", "InvalidCredentials"])(
    "%s unregisters only the rejected device in memory and on disk",
    async (error) => {
      const invalid = "ExponentPushToken[rejected-device]";
      const valid = "ExponentPushToken[working-device]";
      const attempts: string[] = [];
      const delivered: string[] = [];
      expo
        .get("https://exp.host")
        .intercept({ path: "/--/api/v2/push/send", method: "POST" })
        .reply(({ body }) => {
          const message = JSON.parse(String(body)) as { to: string };
          attempts.push(message.to);
          if (message.to === invalid) {
            return { statusCode: 200, data: { data: { status: "error", details: { error } } } };
          }
          delivered.push(message.to);
          return { statusCode: 200, data: { data: { status: "ok" } } };
        })
        .persist();

      const { filePath, options, pushNotifications } = createPersistentStore();
      pushNotifications.renew(invalid);
      pushNotifications.renew(valid);
      const payload = { title: "Agent finished", body: "Done" };

      await pushNotifications.send(payload);
      expect(delivered).toEqual([valid]);
      expect(
        JSON.parse(readFileSync(filePath, "utf8")).subscriptions.map(
          (entry: { token: string }) => entry.token,
        ),
      ).toEqual([valid]);

      attempts.length = 0;
      await pushNotifications.send(payload);
      expect(attempts).toEqual([valid]);

      attempts.length = 0;
      const reloaded = createPushNotifications(options);
      await reloaded.send(payload);
      expect(attempts).toEqual([valid]);
    },
  );

  test.each(["HTTP 503", "MessageRateExceeded"])(
    "%s keeps the device registered for the next notification",
    async (failure) => {
      const token = "ExponentPushToken[temporarily-unavailable]";
      const delivered: string[] = [];
      let firstRequest = true;
      expo
        .get("https://exp.host")
        .intercept({ path: "/--/api/v2/push/send", method: "POST" })
        .reply(({ body }) => {
          if (firstRequest) {
            firstRequest = false;
            return failure === "HTTP 503"
              ? { statusCode: 503, data: { errors: [{ code: "SERVICE_UNAVAILABLE" }] } }
              : {
                  statusCode: 200,
                  data: { data: { status: "error", details: { error: failure } } },
                };
          }
          const message = JSON.parse(String(body)) as { to: string };
          delivered.push(message.to);
          return { statusCode: 200, data: { data: { status: "ok" } } };
        })
        .persist();

      const { filePath, pushNotifications } = createPersistentStore();
      pushNotifications.renew(token);
      const payload = { title: "Agent finished", body: "Done" };

      await pushNotifications.send(payload);
      expect(delivered).toEqual([]);
      expect(
        JSON.parse(readFileSync(filePath, "utf8")).subscriptions.map(
          (entry: { token: string }) => entry.token,
        ),
      ).toEqual([token]);

      await pushNotifications.send(payload);
      expect(delivered).toEqual([token]);
    },
  );
});
