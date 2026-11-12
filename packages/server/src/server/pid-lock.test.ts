import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { mkdtemp, open, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";

import { getHostName } from "./host-name.js";
import { getMachineId } from "./machine-id.js";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  ReclaimLockQueueFullError,
  ReclaimLockTimeoutError,
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

async function startExternalReclaimHolder(lockPath: string) {
  const command = process.platform === "darwin" ? "lockf" : "flock";
  const args = [lockPath, "/bin/sh", "-c", 'printf "\\001"; cat >/dev/null'];
  const holder = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const acquired = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let closeStarted = false;
  holder.once("error", acquired.reject);
  holder.stdout.once("data", () => acquired.resolve());
  holder.once("close", () => {
    acquired.reject(new Error("External lock holder exited before acquiring"));
    closed.resolve();
  });
  await acquired.promise;
  return {
    holder,
    async close() {
      if (closeStarted) return closed.promise;
      closeStarted = true;
      if (holder.pid !== undefined) {
        try {
          process.kill(-holder.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await closed.promise;
    },
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function runProcess(command: string, args: string[]): Promise<number | null> {
  const child = spawn(command, args, { stdio: "ignore" });
  const completion = Promise.withResolvers<number | null>();
  child.once("error", completion.reject);
  child.once("close", (code) => completion.resolve(code));
  return completion.promise;
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

  test("retains a stale heartbeat lock when its local owner is alive", async () => {
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

      await expect(isLocked(paseoHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(paseoHome, null, { ownerPid: replacementOwnerPid }),
      ).resolves.toBe(false);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retains a stale live desktop heartbeat lock", async () => {
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
      ).resolves.toBe(false);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retains a stale live lock written by a pre-heartbeat daemon", async () => {
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
      ).resolves.toBe(false);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("retains a stale live legacy desktop lock", async () => {
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
      ).resolves.toBe(false);

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
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

  test("rejects a different machine with the same hostname and PID", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-machine-collision-"));
    const foreignLock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: getHostName(),
      machineId: "a-different-machine",
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6767",
      heartbeat: true as const,
    };
    try {
      await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(foreignLock));
      expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
      expect(await acquirePidLock(paseoHome, null)).toBe(false);
      await expect(refreshPidLock(paseoHome)).rejects.toBeInstanceOf(PidLockError);
      await updatePidLock(paseoHome, { listen: "127.0.0.1:9999", serverId: "srv_local" });
      await releasePidLock(paseoHome);
      expect(await getPidLockInfo(paseoHome)).toEqual(foreignLock);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("preserves a fresh foreign hostname with a cloned machine id", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cloned-machine-"));
    const foreignLock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: `${getHostName()}-foreign`,
      machineId: await getMachineId(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6767",
      heartbeat: true as const,
    };
    try {
      await writeFile(join(home, "paseo.pid"), JSON.stringify(foreignLock));
      expect(await acquirePidLock(home, null)).toBe(false);
      await expect(refreshPidLock(home)).rejects.toBeInstanceOf(PidLockError);
      await releasePidLock(home);
      expect(await getPidLockInfo(home)).toEqual(foreignLock);
    } finally {
      await rm(home, { recursive: true, force: true });
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

  test("bounds normalized-path admission to 64 pending and removes aborted waiters", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-admission-"));
    const lockPath = join(paseoHome, ".reclaim.lock");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ran: number[] = [];
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const active = withReclaimLock(lockPath, async () => {
      entered.resolve();
      await release.promise;
    });
    const pending: Promise<number>[] = [];
    const aborted = new Error("queued acquisition cancelled");
    try {
      await entered.promise;
      for (let index = 0; index < 64; index += 1) {
        pending.push(
          withReclaimLock(
            relative(process.cwd(), lockPath),
            async () => {
              ran.push(index);
              return index;
            },
            { signal: controllers[index]!.signal },
          ),
        );
      }
      const settled = Promise.allSettled(pending);
      await expect(
        withReclaimLock(`${paseoHome}/unused/../.reclaim.lock`, async () => -1),
      ).rejects.toMatchObject({
        name: "ReclaimLockQueueFullError",
        lockPath,
        maxPending: 64,
      });
      await expect(withReclaimLock(lockPath, async () => -1)).rejects.toBeInstanceOf(
        ReclaimLockQueueFullError,
      );
      for (const controller of controllers.slice(0, 63)) controller.abort(aborted);
      for (const controller of controllers.slice(0, 63)) {
        expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      }
      const replacement = withReclaimLock(lockPath, async () => {
        ran.push(64);
        return 64;
      });
      release.resolve();
      await active;
      expect(await settled).toEqual([
        ...Array.from({ length: 63 }, () => ({ status: "rejected", reason: aborted })),
        { status: "fulfilled", value: 63 },
      ]);
      await expect(replacement).resolves.toBe(64);
      expect(ran).toEqual([63, 64]);
      await expect(stat(join(paseoHome, "unused"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const controller of controllers) controller.abort(aborted);
      release.resolve();
      await Promise.allSettled([active, ...pending]);
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("expires queued acquisition from enqueue without running it and recovers admission", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-queued-timeout-"));
    const lockPath = join(paseoHome, ".reclaim.lock");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let expiredActionRan = false;
    const active = withReclaimLock(lockPath, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      const expired = withReclaimLock(
        lockPath,
        async () => {
          expiredActionRan = true;
        },
        { timeoutMs: 25 },
      );
      await expect(expired).rejects.toBeInstanceOf(ReclaimLockTimeoutError);
      await expect(expired).rejects.toMatchObject({ lockPath, timeoutMs: 25 });
      release.resolve();
      await active;
      await expect(withReclaimLock(lockPath, async () => "recovered")).resolves.toBe("recovered");
      expect(expiredActionRan).toBe(false);
    } finally {
      release.resolve();
      await active;
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("keeps an action protected after its acquisition deadline and subsequent abort", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-action-deadline-"));
    const lockPath = join(paseoHome, ".reclaim.lock");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const events: string[] = [];
    const active = withReclaimLock(
      lockPath,
      async () => {
        entered.resolve();
        await release.promise;
        events.push("active finished");
        return "completed";
      },
      { signal: cancellation.signal, timeoutMs: 2_000 },
    );
    let next: Promise<void> | undefined;
    try {
      await entered.promise;
      expect(getEventListeners(cancellation.signal, "abort")).toEqual([]);
      await delay(2_050);
      cancellation.abort();
      next = withReclaimLock(lockPath, async () => {
        events.push("next began");
      });
      expect(events).toEqual([]);
      release.resolve();
      await expect(active).resolves.toBe("completed");
      await next;
      expect(events).toEqual(["active finished", "next began"]);
    } finally {
      release.resolve();
      await Promise.allSettled([active, next]);
      await rm(paseoHome, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects pre-aborted and zero-deadline acquisitions before filesystem preparation", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-preparation-"));
    const parent = join(paseoHome, "not-created");
    const lockPath = join(parent, ".reclaim.lock");
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    let ran = false;
    async function action(): Promise<void> {
      ran = true;
    }
    try {
      await expect(withReclaimLock(lockPath, action, { signal: controller.signal })).rejects.toBe(
        reason,
      );
      await expect(withReclaimLock(lockPath, action, { timeoutMs: 0 })).rejects.toBeInstanceOf(
        ReclaimLockTimeoutError,
      );
      await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      expect(ran).toBe(false);
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("recovers an idle queue after filesystem preparation fails", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-preparation-failure-"));
    const parent = join(paseoHome, "parent");
    const lockPath = join(parent, ".reclaim.lock");
    let ran = false;
    try {
      await writeFile(parent, "not a directory");
      await expect(
        withReclaimLock(lockPath, async () => {
          ran = true;
        }),
      ).rejects.toThrow();
      expect(ran).toBe(false);
      await unlink(parent);
      await expect(withReclaimLock(lockPath, async () => "recovered")).resolves.toBe("recovered");
    } finally {
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
    "expires the native acquisition helper while the Node event loop cannot run cleanup",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-native-timeout-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      const external = await startExternalReclaimHolder(lockPath);
      const childrenBefore = new Set(await linuxChildPids(process.pid));
      const blocked = withReclaimLock(
        lockPath,
        async () => {
          throw new Error("Native timeout must prevent the action");
        },
        { timeoutMs: 2_000 },
      );
      const outcome = blocked.catch((error: unknown) => error);
      try {
        await expect.poll(() => findFlockHolderPid(childrenBefore)).not.toBeUndefined();
        const helperPid = await findFlockHolderPid(childrenBefore);
        if (helperPid === undefined) throw new Error("Missing native timeout helper");
        const waitWord = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 5_000;
        let nativeExited = false;
        // Deliberately prevent the JavaScript timeout from firing: only the helper's
        // own acquisition deadline can make it exit during this synchronous wait.
        while (!nativeExited && Date.now() < deadline) {
          try {
            const state = readFileSync(`/proc/${helperPid}/stat`, "utf8");
            nativeExited = /^\d+ \(.*\) Z /.test(state);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            nativeExited = true;
          }
          if (!nativeExited) Atomics.wait(waitWord, 0, 0, 10);
        }
        expect(nativeExited).toBe(true);
        expect(await outcome).toBeInstanceOf(ReclaimLockTimeoutError);
        expect(isProcessRunning(external.holder.pid!)).toBe(true);
      } finally {
        await external.close();
        await outcome;
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "times out blocked filesystem preparation without admitting a successor early",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-preparation-timeout-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      expect(await runProcess("mkfifo", [lockPath])).toBe(0);
      let ran = false;
      const preparing = withReclaimLock(
        lockPath,
        async () => {
          ran = true;
        },
        { timeoutMs: 25 },
      );
      try {
        await expect(preparing).rejects.toBeInstanceOf(ReclaimLockTimeoutError);
        const queued = withReclaimLock(
          lockPath,
          async () => {
            ran = true;
          },
          { timeoutMs: 25 },
        );
        await expect(queued).rejects.toBeInstanceOf(ReclaimLockTimeoutError);
        expect(ran).toBe(false);
      } finally {
        // Opening the read side releases the original real, blocked open() operation.
        const reader = await open(lockPath, "r");
        await reader.close();
        await unlink(lockPath);
        await expect(withReclaimLock(lockPath, async () => "recovered")).resolves.toBe("recovered");
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "retains the cross-process lock while an action outlives acquisition timeout",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-long-action-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      try {
        await withReclaimLock(
          lockPath,
          async () => {
            await delay(2_050);
            const command = process.platform === "darwin" ? "lockf" : "flock";
            const args =
              process.platform === "darwin"
                ? ["-t", "0", lockPath, "true"]
                : ["--nonblock", lockPath, "true"];
            expect(await runProcess(command, args)).not.toBe(0);
          },
          { timeoutMs: 2_000 },
        );
        const external = await startExternalReclaimHolder(lockPath);
        await external.close();
      } finally {
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform !== "linux").each(["abort", "timeout"] as const)(
    "cleans a stopped acquisition helper after %s before admitting its successor",
    async (cancellationKind) => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-helper-cancel-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      const external = await startExternalReclaimHolder(lockPath);
      const childrenBefore = new Set(await linuxChildPids(process.pid));
      const cancellation = new AbortController();
      const reason = new Error("acquisition stopped");
      let cancelledActionRan = false;
      const blocked = withReclaimLock(
        lockPath,
        async () => {
          cancelledActionRan = true;
        },
        { signal: cancellation.signal, timeoutMs: 2_000 },
      );
      const outcome = blocked.then(
        () => "unexpected acquisition",
        (error: unknown) => error,
      );
      let successor: Promise<string> | undefined;
      try {
        await expect.poll(() => findFlockHolderPid(childrenBefore)).not.toBeUndefined();
        const helperPid = await findFlockHolderPid(childrenBefore);
        if (helperPid === undefined) throw new Error("Missing blocked lock helper");
        process.kill(-helperPid, "SIGSTOP");
        successor = withReclaimLock(lockPath, async () => {
          expect(isProcessRunning(helperPid)).toBe(false);
          return "successor";
        });
        if (cancellationKind === "abort") {
          cancellation.abort(reason);
          expect(await outcome).toBe(reason);
        } else {
          expect(await outcome).toBeInstanceOf(ReclaimLockTimeoutError);
        }
        expect(isProcessRunning(external.holder.pid!)).toBe(true);
        await external.close();
        await expect(successor).resolves.toBe("successor");
        expect(cancelledActionRan).toBe(false);
        await expect(withReclaimLock(lockPath, async () => "recovered")).resolves.toBe("recovered");
      } finally {
        cancellation.abort(reason);
        await external.close();
        await Promise.allSettled([blocked, successor]);
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform !== "linux")(
    "terminates a lingering owned process group only after its action returns",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-lingering-release-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      const childrenBefore = new Set(await linuxChildPids(process.pid));
      try {
        await expect(
          withReclaimLock(lockPath, async () => {
            const holderPid = await findFlockHolderPid(childrenBefore);
            if (holderPid === undefined) throw new Error("Missing acquired lock helper");
            process.kill(-holderPid, "SIGSTOP");
            return "action completed";
          }),
        ).resolves.toBe("action completed");
        const external = await startExternalReclaimHolder(lockPath);
        await external.close();
      } finally {
        await rm(paseoHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "fails the action when the reclaim lock holder exits without deadlocking",
    async () => {
      const paseoHome = await mkdtemp(join(tmpdir(), "paseo-reclaim-holder-exit-"));
      const lockPath = join(paseoHome, ".reclaim.lock");
      const childrenBefore = new Set(await linuxChildPids(process.pid));
      const warned = Promise.withResolvers<void>();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => warned.resolve());

      try {
        const action = withReclaimLock(lockPath, async () => {
          const holderPid = await findFlockHolderPid(childrenBefore);
          if (holderPid === undefined) throw new Error("Missing acquired lock helper");
          process.kill(holderPid, "SIGKILL");
          await warned.promise;
          const external = await startExternalReclaimHolder(lockPath);
          await external.close();
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
