import { describe, expect, test, vi } from "vitest";

import { PidLockError } from "../src/server/pid-lock.js";
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
