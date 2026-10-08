import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { join } from "node:path";
import pino from "pino";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { AgentStorage } from "./agent/agent-storage.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";

const originalEnv = { ...process.env };

let homeRoot: string;
let staticDir: string;
let projectDir: string;

beforeEach(async () => {
  process.env = { ...originalEnv, PASEO_SUPERVISED: "0" };
  homeRoot = await mkdtemp(join(tmpdir(), "paseo-shared-home-"));
  staticDir = await mkdtemp(join(tmpdir(), "paseo-shared-static-"));
  projectDir = join(homeRoot, "project-a");
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(homeRoot, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
});

/**
 * Polls until the predicate holds. Two real daemons share this process, so fake
 * timers would stall their heartbeat and schedule ticks; the rescan throttle
 * reads the wall clock, so the condition itself is the only reliable signal.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    const { promise: tick, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await tick;
  }
  return predicate();
}

test("two daemons share one home with per-host workspaces and cross-host agent reads", async () => {
  process.env.PASEO_SERVER_ID = "srv_shared_a";
  delete process.env.PASEO_PID_LOCK_OWNER;
  const daemonA = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    staticDir,
    cleanup: false,
  });

  process.env.PASEO_SERVER_ID = "srv_shared_b";
  process.env.PASEO_PID_LOCK_OWNER = "0";
  const daemonB = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    staticDir,
    cleanup: false,
  });

  const clientA = new DaemonClient({
    url: `ws://127.0.0.1:${daemonA.port}/ws`,
    appVersion: "0.1.70",
  });
  const clientB = new DaemonClient({
    url: `ws://127.0.0.1:${daemonB.port}/ws`,
    appVersion: "0.1.70",
  });
  try {
    const paseoHome = daemonA.paseoHome;
    expect(daemonA.port).not.toBe(daemonB.port);
    expect(existsSync(join(paseoHome, "daemons", "srv_shared_a", "instance.json"))).toBe(true);
    expect(existsSync(join(paseoHome, "daemons", "srv_shared_b", "instance.json"))).toBe(true);

    const credentialA = (
      await readFile(join(paseoHome, "daemons", "srv_shared_a", "local-credential"), "utf8")
    ).trim();
    const credentialB = (
      await readFile(join(paseoHome, "daemons", "srv_shared_b", "local-credential"), "utf8")
    ).trim();
    const legacyCredential = (await readFile(join(paseoHome, "local-credential"), "utf8")).trim();
    expect(legacyCredential).toBe(credentialA);
    expect(credentialB).not.toBe(legacyCredential);

    await clientA.connect();
    await clientA.fetchAgents({ subscribe: {} });
    await clientB.connect();
    await clientB.fetchAgents({ subscribe: {} });

    const created = await clientA.createWorkspace({
      source: { kind: "directory", path: projectDir },
    });
    const createdId = created.workspace?.id;
    expect(createdId).toBeTruthy();

    const listA = await clientA.fetchWorkspaces();
    expect(listA.entries.some((entry) => entry.id === createdId)).toBe(true);
    const listB = await clientB.fetchWorkspaces();
    expect(listB.entries.some((entry) => entry.id === createdId)).toBe(false);

    // A separate storage instance simulates the owning host's writer.
    const foreignWriter = new AgentStorage(join(paseoHome, "agents"), pino({ level: "silent" }));
    await foreignWriter.initialize();
    const foreignAgentId = randomUUID();
    const now = new Date().toISOString();
    await foreignWriter.upsert({
      id: foreignAgentId,
      provider: "claude",
      cwd: projectDir,
      workspaceId: createdId,
      createdAt: now,
      updatedAt: now,
      labels: {},
      lastStatus: "running",
      hostId: "srv_shared_a",
    } satisfies StoredAgentRecord);

    const listedOnB = await waitFor(async () => {
      const agents = await clientB.fetchAgents();
      return agents.entries.some((entry) => entry.agent.id === foreignAgentId);
    });
    expect(listedOnB).toBe(true);

    const agentsB = await clientB.fetchAgents();
    const seenOnB = agentsB.entries.find((entry) => entry.agent.id === foreignAgentId);
    expect(seenOnB?.agent.status).toBe("running");

    await expect(clientB.sendMessage(foreignAgentId, "hello from B")).rejects.toThrow(
      /owned by host/,
    );
  } finally {
    await clientA.close();
    await clientB.close();
    await daemonA.close();
    await daemonB.close();
    expect(existsSync(join(daemonA.paseoHome, "daemons", "srv_shared_b", "instance.json"))).toBe(
      false,
    );
  }
}, 60_000);

test("a second daemon adds itself to a local project key instead of replacing it", async () => {
  process.env.PASEO_SERVER_ID = "srv_shared_a";
  delete process.env.PASEO_PID_LOCK_OWNER;
  const daemonA = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    staticDir,
    cleanup: false,
  });

  const clientA = new DaemonClient({
    url: `ws://127.0.0.1:${daemonA.port}/ws`,
    appVersion: "0.1.70",
  });
  let daemonB: TestPaseoDaemon | null = null;
  try {
    await clientA.connect();
    await clientA.fetchAgents({ subscribe: {} });
    await clientA.createWorkspace({ source: { kind: "directory", path: projectDir } });

    const projectsFile = join(daemonA.paseoHome, "projects", "projects.json");
    const readProjectKeys = async (): Promise<string[]> =>
      (JSON.parse(await readFile(projectsFile, "utf8")) as Array<{ projectKey?: string | null }>)
        .map((project) => project.projectKey ?? "")
        .filter((key) => key.length > 0);

    const keysWrittenByFirstDaemon = await waitFor(async () => {
      const keys = await readProjectKeys();
      return keys.length === 1 && keys[0]!.startsWith("host:srv_shared_a:");
    });
    expect(keysWrittenByFirstDaemon).toBe(true);
    const [firstKey] = await readProjectKeys();
    const observedPath = firstKey!.slice("host:srv_shared_a:".length);

    // The second daemon boots onto the same home and reconciles the same project.
    process.env.PASEO_SERVER_ID = "srv_shared_b";
    process.env.PASEO_PID_LOCK_OWNER = "0";
    daemonB = await createTestPaseoDaemon({ paseoHomeRoot: homeRoot, staticDir, cleanup: false });

    const expectedKey = `host:srv_shared_a+srv_shared_b:${observedPath}`;
    const converged = await waitFor(async () => {
      const keys = await readProjectKeys();
      return keys.length === 1 && keys[0] === expectedKey;
    });

    expect(converged).toBe(true);
    expect(await readProjectKeys()).toEqual([expectedKey]);
  } finally {
    await clientA.close();
    await daemonB?.close();
    await daemonA.close();
  }
}, 60_000);
