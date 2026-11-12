import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { getPidLockInfo, PidLockError } from "../src/server/pid-lock.js";
import { getMachineId } from "../src/server/machine-id.js";
import { readDaemonInstance, stopDaemonInstance } from "../src/server/daemon-instance.js";
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

test("isolates real supervisors sharing a home through renewal and shutdown", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-isolation-"));
  const children: { child: ChildProcess; closed: Promise<void> }[] = [];
  const rootPointer = JSON.stringify({
    pid: process.pid,
    hostname: "another-host",
    machineId: await getMachineId(),
    startedAt: new Date().toISOString(),
    uid: process.getuid?.() ?? 0,
    listen: null,
    heartbeat: true,
  });
  await writeFile(path.join(home, "paseo.pid"), rootPointer);
  await writeFile(path.join(home, ".paseo-machine-id"), await getMachineId());
  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    HOME: home,
    USERPROFILE: home,
    PASEO_HOME: home,
    PASEO_LISTEN: "127.0.0.1:0",
    PASEO_RELAY_ENABLED: "false",
    PASEO_NODE_INSPECT: "0",
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    CI: "true",
  };
  function launch(serverId: string) {
    const env = { ...baseEnv, PASEO_SERVER_ID: serverId };
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url)),
        "--dev",
        "--no-relay",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-20_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-20_000);
    });
    const completion = Promise.withResolvers<void>();
    child.once("close", () => completion.resolve());
    child.once("error", completion.reject);
    const closed = completion.promise;
    children.push({ child, closed });
    return { child, env, output: () => output, closed };
  }
  try {
    const first = launch("srv_first");
    const second = launch("srv_second");
    for (const instance of [first, second]) {
      await expect
        .poll(
          async () => {
            if (instance.child.exitCode !== null) throw new Error(instance.output());
            const found = await readDaemonInstance(home, instance.env);
            return found?.pid === instance.child.pid && Boolean(found.listen);
          },
          { timeout: 90_000 },
        )
        .toBe(true);
    }
    const secondPidHome = path.dirname(getDaemonInstancePath(home, "srv_second"));
    const pointerPath = path.join(secondPidHome, "paseo.pid");
    const initialHeartbeat = (await stat(pointerPath)).mtimeMs;
    const duplicate = launch("srv_second");
    await duplicate.closed;
    expect(duplicate.child.exitCode).toBe(1);
    expect(duplicate.output()).toContain("Another Paseo daemon is already running");
    expect(await getPidLockInfo(secondPidHome)).toMatchObject({ pid: second.child.pid });
    await expect
      .poll(async () => (await stat(pointerPath)).mtimeMs, { timeout: 45_000 })
      .toBeGreaterThan(initialHeartbeat);
    expect(await readFile(path.join(home, "paseo.pid"), "utf8")).toBe(rootPointer);
    expect(
      await readFile(path.join(home, "local-credential"), "utf8").catch(() => null),
    ).toBeNull();
    expect(await stopDaemonInstance(home, { env: first.env })).toMatchObject({ action: "stopped" });
    const survivor = await readDaemonInstance(home, second.env);
    expect(survivor).toMatchObject({ pid: second.child.pid, serverId: "srv_second" });
    expect((await fetch(`http://${survivor!.listen}/api/health`)).status).toBe(200);
    expect(await readFile(path.join(home, "paseo.pid"), "utf8")).toBe(rootPointer);
  } finally {
    for (const { child } of children) child.kill("SIGTERM");
    await Promise.all(children.map(({ closed }) => closed));
    await rm(home, { recursive: true, force: true });
  }
}, 150_000);
