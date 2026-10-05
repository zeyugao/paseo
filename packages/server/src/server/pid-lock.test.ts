import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";

import { getHostName } from "./host-name.js";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
  withReclaimLock,
} from "./pid-lock.js";
async function linuxChildPids(pid: number): Promise<number[]> {
  try {
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function killLinuxProcessTree(pid: number): Promise<void> {
  for (const childPid of await linuxChildPids(pid)) await killLinuxProcessTree(childPid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may exit between discovery and signaling.
  }
}

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const paseoHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await expect(acquirePidLock(paseoHome, null, { ownerPid })).resolves.toBe(true);

      if (process.platform !== "win32") {
        expect((await stat(paseoHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await updatePidLock(
        paseoHome,
        { listen: "127.0.0.1:6767", serverId: "srv_test" },
        { ownerPid },
      );

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await releasePidLock(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await releasePidLock(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("replaces a stale heartbeat lock even when its recorded PID is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: false });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).resolves.toBe(true);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("replaces a stale live desktop heartbeat lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(paseoHome, "paseo.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).resolves.toBe(true);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.listen).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("replaces a stale live lock written by a pre-heartbeat daemon", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-live-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).resolves.toBe(true);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid + 10_000);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("replaces a stale live legacy desktop lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).resolves.toBe(true);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(paseoHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("serializes heartbeat refresh with stale-lock replacement", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-reclaim-"));
    const pidPath = join(paseoHome, "paseo.pid");
    const ownerPid = process.pid;
    const replacementOwnerPid = process.pid + 10_000;

    try {
      await acquirePidLock(paseoHome, null, { ownerPid });
      let refresh!: Promise<void>;
      await withReclaimLock(join(paseoHome, ".reclaim.lock"), async () => {
        refresh = refreshPidLock(paseoHome, { ownerPid });
        await delay(100);
        await unlink(pidPath);
        await writeFile(
          pidPath,
          JSON.stringify({
            pid: replacementOwnerPid,
            startedAt: new Date().toISOString(),
            hostname: getHostName(),
            uid: process.getuid?.() ?? 0,
            listen: null,
            heartbeat: true,
          }),
        );
      });

      await expect(refresh).rejects.toBeInstanceOf(PidLockError);
      await expect(getPidLockInfo(paseoHome)).resolves.toMatchObject({ pid: replacementOwnerPid });
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-refresh-rewrite-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await acquirePidLock(paseoHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(paseoHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).resolves.toBe(false);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("leaves a fresh foreign-host discovery lock untouched", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-foreign-fresh-"));
    const pidPath = join(paseoHome, "paseo.pid");
    const nonOwnerPid = process.pid + 10_000;
    const foreignLock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: `${getHostName()}-foreign`,
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6767",
      heartbeat: true as const,
    };
    try {
      await writeFile(pidPath, JSON.stringify(foreignLock));

      await expect(acquirePidLock(paseoHome, null, { ownerPid: nonOwnerPid })).resolves.toBe(false);
      await updatePidLock(
        paseoHome,
        { listen: "127.0.0.1:9999", serverId: "srv_non_owner" },
        { ownerPid: nonOwnerPid },
      );
      await releasePidLock(paseoHome, { ownerPid: nonOwnerPid });
      await expect(getPidLockInfo(paseoHome)).resolves.toEqual(foreignLock);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("replaces a stale foreign-host discovery lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-foreign-stale-"));
    const pidPath = join(paseoHome, "paseo.pid");
    const ownerPid = process.pid + 10_000;
    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: `${getHostName()}-foreign`,
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(acquirePidLock(paseoHome, null, { ownerPid })).resolves.toBe(true);
      await expect(getPidLockInfo(paseoHome)).resolves.toMatchObject({
        hostname: getHostName(),
        pid: ownerPid,
      });
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("replaces a fresh same-host lock whose PID is dead", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-local-dead-"));
    const ownerPid = process.pid + 20_000;
    try {
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid + 10_000,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );

      await expect(acquirePidLock(paseoHome, null, { ownerPid })).resolves.toBe(true);
      await expect(getPidLockInfo(paseoHome)).resolves.toMatchObject({ pid: ownerPid });
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("starts over an empty lock file left by a supervisor killed before writing it", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(paseoHome, "paseo.pid"), "");

      await expect(getPidLockInfo(paseoHome)).resolves.toBeNull();
      await acquirePidLock(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps a lock file whose contents cannot be read as a lock", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-unparseable-"));
    const pidPath = join(paseoHome, "paseo.pid");

    try {
      await writeFile(pidPath, JSON.stringify({ pid: "unknown" }));

      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Cannot read daemon state");

      await expect(readFile(pidPath, "utf-8")).resolves.toBe(JSON.stringify({ pid: "unknown" }));
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("serializes concurrent stale lock reclamation", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-concurrent-reclaim-"));
    const pidPath = join(paseoHome, "paseo.pid");
    const bystander = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error("Failed to start PID lock test process");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid + 20_000,
          startedAt: new Date().toISOString(),
          hostname: getHostName(),
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      const results = await Promise.all([
        acquirePidLock(paseoHome, null, { ownerPid: process.pid }),
        acquirePidLock(paseoHome, null, { ownerPid: bystanderPid }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winnerPid = results[0] ? process.pid : bystanderPid;
      await expect(getPidLockInfo(paseoHome)).resolves.toMatchObject({ pid: winnerPid });
    } finally {
      bystander.kill();
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  async function findFlockHolderPid(childrenBefore: Set<number>): Promise<number | undefined> {
    const spawnedChildren = (await linuxChildPids(process.pid)).filter(
      (pid) => !childrenBefore.has(pid),
    );
    const candidates = await Promise.all(
      spawnedChildren.map(async (pid) => ({
        pid,
        command: await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      })),
    );
    return candidates.find(({ command }) => command.includes("flock"))?.pid;
  }

  test.skipIf(process.platform !== "linux")(
    "fails the action when the reclaim lock holder exits without deadlocking",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-holder-exit-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      const childrenBefore = new Set(await linuxChildPids(process.pid));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const action = withReclaimLock(lockPath, async () => {
          const holderPid = await findFlockHolderPid(childrenBefore);
          expect(holderPid).toBeDefined();
          await killLinuxProcessTree(holderPid!);
          await delay(50);
          return "completed";
        });
        const timeout = delay(2_000).then(() => {
          throw new Error("reclaim lock release timed out");
        });

        await expect(Promise.race([action, timeout])).rejects.toThrow("no longer protected");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer protected"));
      } finally {
        warn.mockRestore();
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
  );
});
