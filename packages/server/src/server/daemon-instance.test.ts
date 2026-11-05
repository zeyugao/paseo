import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  daemonLogPath,
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
} from "./daemon-instance.js";
import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PID_LOCK_STALE_AFTER_MS,
  type PidLockInfo,
} from "./pid-lock.js";
import { getHostName } from "./host-name.js";
import {
  DAEMON_INSTANCE_STALE_AFTER_MS,
  DaemonInstanceLeaseLostError,
  type DaemonInstanceRegistration,
  getDaemonInstancePath,
  readRegisteredDaemonInstance,
  registerDaemonInstance,
} from "./daemon-instance-registry.js";
import { readLocalCredentialForTarget, writeLocalCredential } from "./local-credential.js";

// A process cannot have started before the machine booted, so a lock stamped
// before this boot names a PID that some unrelated process now holds.
function bootedAt(): number {
  return Date.now() - uptime() * 1000;
}

async function writeLock(paseoHome: string, lock: PidLockInfo): Promise<void> {
  await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(lock));
}

function lockFor(pid: number, startedAt: Date): PidLockInfo {
  return {
    pid,
    startedAt: startedAt.toISOString(),
    hostname: getHostName(),
    uid: process.getuid?.() ?? 0,
    listen: "127.0.0.1:6767",
    desktopManaged: true,
    heartbeat: true,
  };
}

describe("daemon instance identity across a reboot", () => {
  let paseoHome: string;
  let bystander: ChildProcess | undefined;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-"));
  });

  afterEach(async () => {
    bystander?.kill("SIGKILL");
    bystander = undefined;
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("uses the env serverId in the default daemon log path", () => {
    expect(daemonLogPath(paseoHome, { PASEO_SERVER_ID: "srv_machine_a" })).toBe(
      join(paseoHome, "daemon.srv_machine_a.log"),
    );
    expect(daemonLogPath(paseoHome, {})).toBe(join(paseoHome, "daemon.log"));
  });

  test("a lock stamped before this boot has no running owner", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    expect(await readDaemonInstance(paseoHome)).toBeNull();
    expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
  });

  test("a supervisor started during this boot still holds the lock", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date()));

    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid: process.pid });
    expect(await isLocked(paseoHome)).toMatchObject({ locked: true });
  });

  test("a new supervisor takes over a lock stamped before this boot", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

    expect(await getPidLockInfo(paseoHome)).toMatchObject({ pid: process.pid + 10_000 });
  });

  test("stopping a lock stamped before this boot leaves the process holding that pid alone", async () => {
    // Records delivery rather than dying of it, so a signal cannot be missed by arriving late.
    const signalMarker = join(paseoHome, "bystander-signalled");
    bystander = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(signalMarker)}, "SIGTERM"));` +
          `setTimeout(() => {}, 120_000);`,
      ],
      { stdio: "ignore" },
    );
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error("bystander process did not start");
    let exited = false;
    bystander.once("exit", () => {
      exited = true;
    });

    await writeLock(paseoHome, lockFor(bystanderPid, new Date(bootedAt() - 60 * 60_000)));

    expect(await stopDaemonInstance(paseoHome)).toMatchObject({ action: "not_running" });

    expect(existsSync(signalMarker)).toBe(false);
    expect(exited).toBe(false);
    await expect(readFile(join(paseoHome, "paseo.pid"), "utf-8")).rejects.toThrow(/ENOENT/);
  });

  test("an aged local heartbeat remains discoverable and can be stopped", async () => {
    bystander = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await once(bystander, "spawn");
    const pid = bystander.pid!;
    await writeLock(paseoHome, lockFor(pid, new Date()));
    const stale = new Date(Date.now() - PID_LOCK_STALE_AFTER_MS - 1000);
    await utimes(join(paseoHome, "paseo.pid"), stale, stale);
    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid });
    expect(await stopDaemonInstance(paseoHome)).toMatchObject({ action: "stopped", pid });
  });
});

describe("selected daemon discovery on a shared home", () => {
  let home: string;
  let child: ChildProcess;
  let registration: DaemonInstanceRegistration | undefined;
  const serverId = "srv_local_discovery";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-local-discovery-"));
    vi.stubEnv("PASEO_SERVER_ID", serverId);
    child = spawn(
      process.execPath,
      ["-e", 'process.on("message", () => process.send("alive")); process.send("ready");'],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    expect((await once(child, "message"))[0]).toBe("ready");
  });

  afterEach(async () => {
    child.kill("SIGKILL");
    await registration?.release();
    registration = undefined;
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function expectChildAlive(): Promise<void> {
    const response = once(child, "message");
    child.send!("ping");
    expect((await response)[0]).toBe("alive");
  }

  test("discovers and stops the local registered daemon without changing a foreign root pointer", async () => {
    const pointer = {
      ...lockFor(process.pid, new Date()),
      hostname: "foreign-host",
      serverId: "srv_foreign",
    };
    await writeLock(home, pointer);
    registration = await registerDaemonInstance(home, serverId, {
      ownerPid: child.pid,
      listen: "127.0.0.1:6779",
    });
    const token = await writeLocalCredential(home, { serverId });
    const instance = await readDaemonInstance(home);
    expect(instance).toMatchObject({ pid: child.pid, serverId, listen: "127.0.0.1:6779" });
    expect(await readLocalCredentialForTarget(home, "tcp://localhost:6779")).toBe(token);
    expect(await readLocalCredentialForTarget(home, "localhost:6767")).toBeNull();
    expect(
      await startDaemonInstance({
        home,
        command: "must-not-spawn-an-existing-daemon",
        args: [],
        env: { ...process.env },
        mode: "managed",
      }),
    ).toMatchObject({ spawned: false, instance: { pid: child.pid } });
    const selectedEnv = { ...process.env, PASEO_SERVER_ID: serverId };
    vi.stubEnv("PASEO_SERVER_ID", "srv_unselected");
    expect(await stopDaemonInstance(home, { instance: instance!, env: selectedEnv })).toMatchObject(
      {
        action: "stopped",
        pid: child.pid,
      },
    );
    expect(await getPidLockInfo(home)).toEqual(pointer);
  });

  test("rejects a foreign registration even when its PID exists locally", async () => {
    registration = await registerDaemonInstance(home, serverId, {
      machineId: "foreign-machine",
      ownerPid: child.pid,
      listen: "127.0.0.1:6779",
    });
    await writeLocalCredential(home, { serverId });
    expect(await readLocalCredentialForTarget(home, "localhost:6779")).toBeNull();
    expect(await readDaemonInstance(home)).toBeNull();
    expect(await stopDaemonInstance(home, { force: true })).toMatchObject({
      action: "not_running",
    });
    await expectChildAlive();
    expect(await readRegisteredDaemonInstance(home, serverId)).toMatchObject({
      machineId: "foreign-machine",
    });
  });

  test("does not signal a reused PID whose birth no longer matches the registration", async () => {
    registration = await registerDaemonInstance(home, serverId, {
      ownerPid: child.pid,
      listen: "127.0.0.1:6779",
    });
    await writeLocalCredential(home, { serverId });
    await writeFile(
      getDaemonInstancePath(home, serverId),
      JSON.stringify({
        ...registration.info,
        processStartedAt: "a different process birth",
      }),
    );
    expect(await readDaemonInstance(home)).toBeNull();
    expect(await readLocalCredentialForTarget(home, "localhost:6779")).toBeNull();
    expect(await stopDaemonInstance(home, { force: true })).toMatchObject({
      action: "not_running",
    });
    await expectChildAlive();
  });

  test("does not guess ownership of a legacy registration with unknown machine identity", async () => {
    registration = await registerDaemonInstance(home, serverId, {
      ownerPid: child.pid,
      listen: "127.0.0.1:6779",
    });
    await writeLocalCredential(home, { serverId });
    const { machineId: _machineId, ...legacy } = registration.info;
    await writeFile(getDaemonInstancePath(home, serverId), JSON.stringify(legacy));
    expect(await readDaemonInstance(home)).toBeNull();
    expect(await readLocalCredentialForTarget(home, "localhost:6779")).toBeNull();
    expect(await stopDaemonInstance(home, { force: true })).toMatchObject({
      action: "not_running",
    });
    await expectChildAlive();
  });

  test("a stale local registered owner remains discoverable and cannot be replaced", async () => {
    registration = await registerDaemonInstance(home, serverId, { ownerPid: child.pid });
    const stale = new Date(Date.now() - DAEMON_INSTANCE_STALE_AFTER_MS - 1000);
    await utimes(getDaemonInstancePath(home, serverId), stale, stale);
    expect(await readDaemonInstance(home)).toMatchObject({ pid: child.pid });
    await expect(registerDaemonInstance(home, serverId)).rejects.toThrow(
      "Another Paseo daemon is already running",
    );
  });

  test("status reads do not create server identity on an empty home", async () => {
    vi.stubEnv("PASEO_SERVER_ID", "");
    expect(await readDaemonInstance(home)).toBeNull();
    expect(existsSync(join(home, "server-id"))).toBe(false);
    expect(existsSync(join(home, "daemons"))).toBe(false);
  });
});

// Linux keeps a boot's id while a VM is paused for a host sleep, though the VM's wall clock
// runs ahead of its uptime once it resumes. A sleep longer than the time between boot and
// the supervisor's start puts the wall-clock boot instant after the lock's startedAt.
describe.runIf(process.platform === "linux")("daemon instance identity on Linux", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-linux-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("a supervisor still holds the lock after its paused VM resumes", async () => {
    await acquirePidLock(paseoHome, null, { ownerPid: process.pid });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + uptime() * 1000 + 12 * 60 * 60_000);

    // A resumed supervisor refreshes its heartbeat within one interval; simulate that
    // touch under the jumped clock so this test exercises boot recency, not staleness.
    const resumed = new Date(Date.now() - 30_000);
    await utimes(join(paseoHome, "paseo.pid"), resumed, resumed);

    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid: process.pid });
    expect(await isLocked(paseoHome)).toMatchObject({ locked: true });
    await expect(acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 })).resolves.toBe(
      false,
    );
  });

  test("a lock written during another boot has no running owner", async () => {
    await writeLock(paseoHome, {
      ...lockFor(process.pid, new Date()),
      bootId: "00000000-0000-0000-0000-000000000000",
    });

    expect(await readDaemonInstance(paseoHome)).toBeNull();
    expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
  });
});

describe("per-server daemon instance registry", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-registry-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("rejects a live same-host owner with the legacy double-start message", async () => {
    const first = await registerDaemonInstance(paseoHome, "srv_same_host", {
      hostname: "host-a",
      machineId: "machine-a",
      ownerPid: process.pid,
    });
    try {
      await expect(
        registerDaemonInstance(paseoHome, "srv_same_host", {
          hostname: "host-a",
          machineId: "machine-a",
          ownerPid: 202,
        }),
      ).rejects.toThrow("Another Paseo daemon is already running");
      await expect(readRegisteredDaemonInstance(paseoHome, "srv_same_host")).resolves.toMatchObject(
        { bootId: first.info.bootId, pid: process.pid },
      );
    } finally {
      await first.release();
    }
  });

  test("rejects a fresh foreign-host owner without clearing its registry", async () => {
    const first = await registerDaemonInstance(paseoHome, "srv_shared", {
      hostname: "host-a",
      machineId: "machine-a",
      ownerPid: 101,
    });
    try {
      await expect(
        registerDaemonInstance(paseoHome, "srv_shared", {
          machineId: "machine-b",
          hostname: "host-b",
          ownerPid: 202,
        }),
      ).rejects.toThrow("Set a different PASEO_SERVER_ID for this machine");
      await expect(readRegisteredDaemonInstance(paseoHome, "srv_shared")).resolves.toMatchObject({
        bootId: first.info.bootId,
        hostname: "host-a",
      });
    } finally {
      await first.release();
    }
  });

  test("replaces a stale foreign-host registry", async () => {
    const serverId = "srv_stale_foreign";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        serverId,
        hostname: "host-a",
        pid: 101,
        bootId: "00000000-0000-4000-8000-000000000001",
        startedAt: new Date().toISOString(),
      }),
    );
    const staleTime = new Date(Date.now() - DAEMON_INSTANCE_STALE_AFTER_MS - 1_000);
    await utimes(filePath, staleTime, staleTime);

    const replacement = await registerDaemonInstance(paseoHome, serverId, {
      hostname: "host-b",
      machineId: "machine-b",
      ownerPid: 202,
    });
    try {
      expect(replacement.info.hostname).toBe("host-b");
      expect(replacement.info.bootId).not.toBe("00000000-0000-4000-8000-000000000001");
    } finally {
      await replacement.release();
    }
  });

  test("retains a stale same-machine registry when its owner is alive", async () => {
    const serverId = "srv_stale_local";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        serverId,
        hostname: "host-a",
        machineId: "machine-a",
        pid: process.pid,
        bootId: "00000000-0000-4000-8000-000000000004",
        startedAt: new Date().toISOString(),
      }),
    );
    const staleTime = new Date(Date.now() - DAEMON_INSTANCE_STALE_AFTER_MS - 1_000);
    await utimes(filePath, staleTime, staleTime);

    await expect(
      registerDaemonInstance(paseoHome, serverId, {
        hostname: "host-a",
        machineId: "machine-a",
        ownerPid: 202,
      }),
    ).rejects.toThrow("Another Paseo daemon is already running");
    expect((await readRegisteredDaemonInstance(paseoHome, serverId))?.pid).toBe(process.pid);
  });

  test("reclaims a persistently corrupt stale registry", async () => {
    const serverId = "srv_stale_corrupt";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{not-json");
    const staleTime = new Date(Date.now() - DAEMON_INSTANCE_STALE_AFTER_MS - 1_000);
    await utimes(filePath, staleTime, staleTime);

    const replacement = await registerDaemonInstance(paseoHome, serverId, {
      hostname: "host-b",
      machineId: "machine-b",
      ownerPid: 202,
    });
    try {
      expect(replacement.info.serverId).toBe(serverId);
      await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toMatchObject(
        replacement.info,
      );
    } finally {
      await replacement.release();
    }
  });

  test("does not reclaim a fresh legacy registry from the same hostname", async () => {
    const serverId = "srv_fresh_legacy";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    const legacyBootId = "00000000-0000-4000-8000-000000000002";
    await writeFile(
      filePath,
      JSON.stringify({
        serverId,
        hostname: "shared-hostname",
        pid: process.pid + 100_000,
        bootId: legacyBootId,
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      registerDaemonInstance(paseoHome, serverId, {
        hostname: "shared-hostname",
        machineId: "machine-a",
        ownerPid: process.pid,
      }),
    ).rejects.toThrow("Another Paseo daemon is already running");
    await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toMatchObject({
      bootId: legacyBootId,
      pid: process.pid + 100_000,
    });
  });

  test("does not reclaim a fresh same-machine registry when its PID is not visible", async () => {
    const serverId = "srv_fresh_same_machine";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    const existingBootId = "00000000-0000-4000-8000-000000000003";
    await writeFile(
      filePath,
      JSON.stringify({
        serverId,
        hostname: "host-a",
        machineId: "machine-a",
        pid: process.pid + 100_000,
        bootId: existingBootId,
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      registerDaemonInstance(paseoHome, serverId, {
        hostname: "host-a",
        machineId: "machine-a",
        ownerPid: process.pid,
      }),
    ).rejects.toThrow("Another Paseo daemon is already running");
    await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toMatchObject({
      bootId: existingBootId,
      machineId: "machine-a",
    });
  });

  test("treats matching hostnames with different machine ids as foreign", async () => {
    const first = await registerDaemonInstance(paseoHome, "srv_hostname_collision", {
      hostname: "shared-hostname",
      machineId: "machine-a",
      ownerPid: 101,
    });
    try {
      await expect(
        registerDaemonInstance(paseoHome, "srv_hostname_collision", {
          hostname: "shared-hostname",
          machineId: "machine-b",
          ownerPid: 202,
        }),
      ).rejects.toThrow("Set a different PASEO_SERVER_ID for this machine");
      await expect(
        readRegisteredDaemonInstance(paseoHome, "srv_hostname_collision"),
      ).resolves.toMatchObject({ machineId: "machine-a", pid: 101 });
    } finally {
      await first.release();
    }
  });

  test("reports a lost lease when another instance replaces the heartbeat path", async () => {
    const serverId = "srv_heartbeat_replaced";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    const heartbeatErrors: unknown[] = [];
    const registration = await registerDaemonInstance(paseoHome, serverId, {
      hostname: "host-a",
      machineId: "machine-a",
      ownerPid: process.pid,
      heartbeatIntervalMs: 10,
      onHeartbeatError: (error) => heartbeatErrors.push(error),
    });
    const replacement = {
      ...registration.info,
      pid: process.pid + 1,
      bootId: "00000000-0000-4000-8000-000000000006",
    };
    const replacementPath = `${filePath}.replacement`;
    await writeFile(replacementPath, JSON.stringify(replacement));
    await rename(replacementPath, filePath);

    await expect.poll(() => heartbeatErrors.length).toBeGreaterThan(0);
    expect(heartbeatErrors[0]).toBeInstanceOf(DaemonInstanceLeaseLostError);
    expect(heartbeatErrors[0]).toMatchObject({ currentInstance: replacement });
    await registration.release();
    await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toMatchObject(
      replacement,
    );
  });

  test("serializes concurrent reclamation without deleting the winner", async () => {
    const serverId = "srv_concurrent_reclaim";
    const filePath = getDaemonInstancePath(paseoHome, serverId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        serverId,
        hostname: "shared-hostname",
        machineId: "stale-machine",
        pid: 101,
        bootId: "00000000-0000-4000-8000-000000000005",
        startedAt: new Date().toISOString(),
      }),
    );
    const staleTime = new Date(Date.now() - DAEMON_INSTANCE_STALE_AFTER_MS - 1_000);
    await utimes(filePath, staleTime, staleTime);

    const attempts = await Promise.allSettled([
      registerDaemonInstance(paseoHome, serverId, {
        hostname: "shared-hostname",
        machineId: "machine-a",
        ownerPid: 201,
      }),
      registerDaemonInstance(paseoHome, serverId, {
        hostname: "shared-hostname",
        machineId: "machine-a",
        ownerPid: 202,
      }),
    ]);
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<DaemonInstanceRegistration> =>
        attempt.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(readRegisteredDaemonInstance(paseoHome, serverId)).resolves.toMatchObject({
      bootId: winners[0].value.info.bootId,
      pid: winners[0].value.info.pid,
    });
    await winners[0].value.release();
  });
});
