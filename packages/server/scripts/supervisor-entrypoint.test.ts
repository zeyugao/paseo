import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { PidLockError } from "../src/server/pid-lock.js";
import {
  getDaemonInstancePath,
  readRegisteredDaemonInstance,
  releaseDaemonInstanceForExitedWorker,
} from "../src/server/daemon-instance-registry.js";
import { createPidLockHeartbeatCallbacks } from "./supervisor-entrypoint.js";

describe("supervisor PID-lock heartbeat", () => {
  test("requests shutdown after three consecutive non-ownership failures", () => {
    const requestShutdown = vi.fn();
    const reportError = vi.fn();
    const callbacks = createPidLockHeartbeatCallbacks({ reportError, requestShutdown });

    callbacks.onError(new Error("EACCES"));
    callbacks.onError(new Error("NFS unavailable"));
    expect(requestShutdown).not.toHaveBeenCalled();

    callbacks.onError(new Error("EIO"));
    expect(requestShutdown).toHaveBeenCalledOnce();
    expect(requestShutdown).toHaveBeenCalledWith("pid_lock_heartbeat_failed");
    expect(reportError).toHaveBeenCalledTimes(3);
  });

  test("successful refresh resets the consecutive failure count", () => {
    const requestShutdown = vi.fn();
    const callbacks = createPidLockHeartbeatCallbacks({
      reportError: vi.fn(),
      requestShutdown,
    });

    callbacks.onError(new Error("first"));
    callbacks.onError(new Error("second"));
    callbacks.onSuccess();
    callbacks.onError(new Error("third"));
    callbacks.onError(new Error("fourth"));

    expect(requestShutdown).not.toHaveBeenCalled();
  });

  test("ownership loss still requests immediate shutdown", () => {
    const requestShutdown = vi.fn();
    const callbacks = createPidLockHeartbeatCallbacks({
      reportError: vi.fn(),
      requestShutdown,
    });

    callbacks.onError(new PidLockError("replaced"));

    expect(requestShutdown).toHaveBeenCalledWith("pid_lock_ownership_lost");
  });
});

describe("supervisor worker instance cleanup", () => {
  test("releases only the exited local worker's instance lease", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-instance-"));
    const serverId = "srv_worker_cleanup";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    const instance = {
      serverId,
      hostname: hostname(),
      machineId: "machine-a",
      pid: 4242,
      bootId: "00000000-0000-4000-8000-000000000001",
      startedAt: "2026-10-05T00:00:00.000Z",
    };

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(instance));

      await expect(releaseDaemonInstanceForExitedWorker(paseoHome, serverId, 4243)).resolves.toBe(
        false,
      );
      await expect(
        releaseDaemonInstanceForExitedWorker(paseoHome, serverId, 4242, "other-host"),
      ).resolves.toBe(false);
      await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toEqual(instance);

      await expect(releaseDaemonInstanceForExitedWorker(paseoHome, serverId, 4242)).resolves.toBe(
        true,
      );
      await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
