import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "./managed-processes/managed-processes.js";
import { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

let tempRoot: string | null = null;
let staticDir: string | null = null;

afterEach(async () => {
  await Promise.all([
    tempRoot ? rm(tempRoot, { recursive: true, force: true }) : Promise.resolve(),
    staticDir ? rm(staticDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
  tempRoot = null;
  staticDir = null;
});

describe("daemon managed process bootstrap", () => {
  test("reaps stale helpers only after acquiring the daemon instance lease", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const ownerProcesses = new FakeManagedProcesses();
    const contenderProcesses = new FakeManagedProcesses();
    const config = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
    } as PaseoDaemonConfig;
    const owner = await createPaseoDaemon(
      { ...config, managedProcesses: ownerProcesses },
      pino({ level: "silent" }),
    );
    let contender: PaseoDaemon | null = null;

    try {
      expect(ownerProcesses.reapCount).toBe(0);
      await owner.start();
      expect(ownerProcesses.reapCount).toBe(1);

      contender = await createPaseoDaemon(
        { ...config, managedProcesses: contenderProcesses },
        pino({ level: "silent" }),
      );
      expect(contenderProcesses.reapCount).toBe(0);
      await expect(contender.start()).rejects.toThrow("Another Paseo daemon is already running");
      expect(contenderProcesses.reapCount).toBe(0);
    } finally {
      await Promise.allSettled([owner.stop(), contender?.stop()]);
    }
  });
});

class FakeManagedProcesses implements ManagedProcessRegistry {
  reapCount = 0;

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    return {
      id: "unused",
      ...input,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: "unused",
    };
  }

  async remove(): Promise<void> {}

  async list(): Promise<ManagedProcessRecord[]> {
    return [];
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    this.reapCount += 1;
    return {
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    };
  }
}
