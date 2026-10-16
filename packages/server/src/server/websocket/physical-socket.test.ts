import { getEventListeners } from "node:events";
import { expect, test } from "vitest";
import {
  APPLICATION_SOCKET_LEASE_MS,
  ApplicationSocketLease,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  sendBoundedPhysicalFrame,
  sendBoundedPhysicalFrameAndWait,
} from "./physical-socket.js";

test("sockets remain exempt until they send an application ping", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const legacySocket = {};
  now = APPLICATION_SOCKET_LEASE_MS * 10;

  expect(lease.listExpired()).toEqual([]);
  lease.renew(legacySocket);
  expect(lease.listExpired()).toEqual([]);
});

test("inbound activity renews a claimed lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const applicationSocket = {};
  lease.claim(applicationSocket);

  now = APPLICATION_SOCKET_LEASE_MS - 1;
  lease.renew(applicationSocket);
  now += APPLICATION_SOCKET_LEASE_MS - 1;
  expect(lease.listExpired()).toEqual([]);

  now += 1;
  expect(lease.listExpired()).toEqual([applicationSocket]);
  lease.release(applicationSocket);
  expect(lease.listExpired()).toEqual([]);
});

test("an application ping claims a socket lease", () => {
  let now = 0;
  const lease = new ApplicationSocketLease<object>(() => now);
  const rawSocket = {};

  lease.claim(rawSocket);
  now = APPLICATION_SOCKET_LEASE_MS;

  expect(lease.listExpired()).toEqual([rawSocket]);
});

test("the shared physical send boundary rejects binary above the hard bound", () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let terminated = false;
  const socket = {
    readyState: 1,
    bufferedAmount: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 1,
    send: (data: string | Uint8Array | ArrayBuffer) => sent.push(data),
  };

  const accepted = sendBoundedPhysicalFrame({
    socket,
    frame: new Uint8Array(2),
    onHighWater: () => {
      terminated = true;
    },
  });

  expect(accepted).toBe(false);
  expect(sent).toEqual([]);
  expect(terminated).toBe(true);
});

test("the awaitable physical send resolves only when that frame send completes", async () => {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let completeSend: (() => void) | undefined;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
      sent.push(_data);
      if (callback) completeSend = () => callback();
    },
  };
  let completed = false;

  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: new Uint8Array([1, 2, 3]),
    onHighWater: () => undefined,
  }).then(() => {
    return (completed = true);
  });

  await Promise.resolve();
  expect(completed).toBe(false);
  expect(
    sendBoundedPhysicalFrame({
      socket,
      frame: "unrelated",
      onHighWater: () => undefined,
    }),
  ).toBe(true);
  expect(sent).toEqual([new Uint8Array([1, 2, 3]), "unrelated"]);
  completeSend?.();
  await sending;
  expect(completed).toBe(true);
});

test("the awaitable physical send rejects callback errors", async () => {
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) =>
      callback?.(new Error("send failed")),
  };

  await expect(
    sendBoundedPhysicalFrameAndWait({
      socket,
      frame: new Uint8Array([1]),
      onHighWater: () => undefined,
    }),
  ).rejects.toThrow("send failed");
});

test("an already aborted physical send does not consume a frame", async () => {
  const controller = new AbortController();
  controller.abort();
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let highWaterReached = false;
  const socket = {
    readyState: 1,
    bufferedAmount: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
    send: (frame: string | Uint8Array | ArrayBuffer) => {
      sent.push(frame);
    },
  };

  await expect(
    sendBoundedPhysicalFrameAndWait({
      socket,
      frame: "cancelled",
      signal: controller.signal,
      onHighWater: () => {
        highWaterReached = true;
      },
    }),
  ).resolves.toBe(false);
  expect(sent).toEqual([]);
  expect(highWaterReached).toBe(false);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("aborting a callback send releases its wait without another frame", async () => {
  const controller = new AbortController();
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let completeSend: ((error?: Error) => void) | undefined;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
      sent.push(frame);
      completeSend = callback;
    },
  };
  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: "pending",
    signal: controller.signal,
    onHighWater: () => undefined,
  });

  expect(completeSend).toBeTypeOf("function");
  controller.abort();
  await expect(sending).resolves.toBe(false);
  expect(sent).toEqual(["pending"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

  completeSend?.(new Error("late callback failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(sending).resolves.toBe(false);
  expect(sent).toEqual(["pending"]);
});

test("aborting a promise send releases its wait and handles a late rejection", async () => {
  const controller = new AbortController();
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let rejectSend: ((error: Error) => void) | undefined;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array | ArrayBuffer) => {
      sent.push(frame);
      return new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      });
    },
  };
  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: "pending",
    signal: controller.signal,
    onHighWater: () => undefined,
  });

  expect(rejectSend).toBeTypeOf("function");
  controller.abort();
  await expect(sending).resolves.toBe(false);
  expect(sent).toEqual(["pending"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

  rejectSend?.(new Error("late promise failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(sending).resolves.toBe(false);
  expect(sent).toEqual(["pending"]);
});

test.each(["callback", "promise"] as const)(
  "a %s send completes normally and releases its abort listener",
  async (transport) => {
    const controller = new AbortController();
    let completeSend: (() => void) | undefined;
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (_frame: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
        if (transport === "promise") {
          return new Promise<void>((resolve) => {
            completeSend = resolve;
          });
        }
        completeSend = () => callback?.();
      },
    };
    let completed = false;
    const sending = sendBoundedPhysicalFrameAndWait({
      socket,
      frame: "pending",
      signal: controller.signal,
      onHighWater: () => undefined,
    });
    void sending.then(() => {
      return (completed = true);
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(completeSend).toBeTypeOf("function");
    completeSend?.();
    await expect(sending).resolves.toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await expect(sending).resolves.toBe(true);
  },
);

test.each(["callback", "promise"] as const)(
  "a %s send failure remains observable and releases its abort listener",
  async (transport) => {
    const controller = new AbortController();
    const failure = new Error("send failed");
    let failSend: ((error: Error) => void) | undefined;
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (_frame: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => {
        if (transport === "promise") {
          return new Promise<void>((_resolve, reject) => {
            failSend = reject;
          });
        }
        failSend = callback;
      },
    };
    const sending = sendBoundedPhysicalFrameAndWait({
      socket,
      frame: "pending",
      signal: controller.signal,
      onHighWater: () => undefined,
    });
    const rejected = expect(sending).rejects.toBe(failure);

    expect(failSend).toBeTypeOf("function");
    failSend?.(failure);
    await rejected;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await expect(sending).rejects.toBe(failure);
  },
);

test("a synchronous physical send completes and releases its abort listener", async () => {
  const controller = new AbortController();
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string | Uint8Array | ArrayBuffer) => {
      sent.push(frame);
    },
  };
  const sending = sendBoundedPhysicalFrameAndWait({
    socket,
    frame: "complete",
    signal: controller.signal,
    onHighWater: () => undefined,
  });

  await expect(sending).resolves.toBe(true);
  expect(sent).toEqual(["complete"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  controller.abort();
  await expect(sending).resolves.toBe(true);
});
