import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { toAgentPayload } from "./agent-projections.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { attachAgentStoragePersistence } from "../persistence-hooks.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";

/**
 * Providers emit connection metadata (`usage_updated` from OMP's initial usage read,
 * `thread_started`, mode/model refreshes) as soon as the resumed session is subscribed.
 * None of it is user or agent activity, so loading a chat must not move `updatedAt`.
 */
function createMetadataOnSubscribeClient(): AgentClient {
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }
  const emitMetadataOnSubscribe = (session: AgentSession): AgentSession =>
    new Proxy(session, {
      get(target, property) {
        if (property === "subscribe") {
          return (callback: (event: AgentStreamEvent) => void) => {
            const unsubscribe = target.subscribe(callback);
            callback({
              type: "usage_updated",
              provider: target.provider,
              usage: { contextWindowUsedTokens: 1024, contextWindowMaxTokens: 200_000 },
            });
            return unsubscribe;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) =>
      emitMetadataOnSubscribe(await baseClient.createSession(config, launchContext)),
    resumeSession: async (handle, overrides, launchContext, options) =>
      emitMetadataOnSubscribe(
        await baseClient.resumeSession(handle, overrides, launchContext, options),
      ),
    fetchCatalog: (options) => baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
}

function createPurposeCapturingClient(
  resumeOptions: Array<AgentResumeSessionOptions | undefined>,
): AgentClient {
  const baseClient = createTestAgentClients().codex;
  return {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
}

async function createWorkspaceRegistry(root: string): Promise<FileBackedWorkspaceRegistry> {
  const registry = new FileBackedWorkspaceRegistry(
    path.join(root, "workspaces.json"),
    createTestLogger(),
  );
  const timestamp = new Date().toISOString();
  await registry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "workspace-local",
      projectId: "project-local",
      cwd: root,
      hostId: "host-a",
      kind: "directory",
      displayName: "local",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  return registry;
}

test.each(["create", "import", "resume", "reload"] as const)(
  "rejects %s execution in a foreign workspace without changing the agent",
  async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-owner-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const workspaceRegistry = await createWorkspaceRegistry(root);
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      workspaceRegistry,
      serverId: "host-a",
      logger,
    });
    const agentId = "00000000-0000-4000-8000-000000000601";

    try {
      await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
        workspaceId: "workspace-local",
      });
      if (operation === "resume") await manager.closeAgent(agentId);
      const stored = await storage.getFresh(agentId);
      if (!stored?.persistence) throw new Error("expected a persisted agent");
      await workspaceRegistry.update("workspace-local", (record) => ({
        ...record,
        hostId: "host-b",
      }));

      let opening: Promise<unknown>;
      switch (operation) {
        case "create":
          opening = manager.createAgent({ provider: "codex", cwd: root }, agentId, {
            workspaceId: "workspace-local",
          });
          break;
        case "import":
          opening = manager.importProviderSession({
            provider: "codex",
            providerHandleId: stored.persistence.sessionId,
            cwd: root,
            workspaceId: "workspace-local",
          });
          break;
        case "resume":
          opening = manager.resumeAgentFromPersistence(stored.persistence, { cwd: root }, agentId, {
            workspaceId: "caller-supplied-workspace",
          });
          break;
        case "reload":
          opening = manager.reloadAgentSession(agentId);
          break;
      }
      await expect(opening).rejects.toThrow("Workspace workspace-local is owned by host host-b");
      expect(await storage.getFresh(agentId)).toEqual(stored);
      expect(manager.getAgent(agentId)?.lifecycle ?? "closed").toBe(stored.lastStatus);
    } finally {
      await manager.closeAgent(agentId);
      await Promise.all([manager.flush(), storage.flush()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["load", "rescan"] as const)(
  "resumes on the workspace host after repairing ownership through %s",
  async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-repaired-owner-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const workspaceRegistry = await createWorkspaceRegistry(root);
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      workspaceRegistry,
      serverId: "host-a",
      logger,
    });
    const agentId = "00000000-0000-4000-8000-000000000602";
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);

    try {
      await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
        workspaceId: "workspace-local",
      });
      await manager.closeAgent(agentId);
      const stored = await storage.getFresh(agentId);
      if (!stored) throw new Error("expected a persisted agent");
      await storage.upsert({ ...stored, hostId: "host-b" });
      const history = await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        logger,
      });
      expect(history.hostId).toBe("host-b");
      await expect(manager.runAgent(agentId, "do not execute remotely")).rejects.toThrow(
        "agent is owned by host host-b",
      );

      await storage.upsert(stored);
      if (operation === "rescan") {
        now.mockReturnValue(20_000);
        await storage.list();
        await manager.flush();
      }
      const resumed = await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        logger,
      });
      expect(resumed.hostId).toBe("host-a");
      expect(resumed.workspaceId).toBe("workspace-local");
      await manager.runAgent(agentId, "continue on the workspace host");
      await manager.flush();
      await storage.flush();
      expect(await storage.getFresh(agentId)).toMatchObject({
        hostId: "host-a",
        workspaceId: "workspace-local",
        lastStatus: "idle",
      });
      expect((await workspaceRegistry.get("workspace-local"))?.hostId).toBe("host-a");
    } finally {
      now.mockRestore();
      await manager.closeAgent(agentId);
      await Promise.all([manager.flush(), storage.flush()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a foreign active agent as read-only history without rewriting its record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-history-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client = createPurposeCapturingClient(resumeOptions);
  const owner = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000303";
  let detachPersistence: (() => void) | null = null;

  try {
    await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected stored foreign agent");
    }
    await storage.upsert({ ...stored, lastStatus: "running" });

    const applySnapshot = vi.spyOn(storage, "applySnapshot");
    const upsert = vi.spyOn(storage, "upsert");
    detachPersistence = attachAgentStoragePersistence(logger, reader, storage, "host-b");
    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    await reader.flush();

    expect(resumeOptions).toEqual([{ purpose: "history" }]);
    expect(loaded.hostId).toBe("host-a");
    expect(loaded.lifecycle).toBe("idle");
    expect(toAgentPayload(loaded).status).toBe("running");
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    await expect(reader.runAgent(agentId, "do not run")).rejects.toThrow(
      "agent is owned by host host-a",
    );
    await expect(reader.cancelAgentRun(agentId)).rejects.toThrow("agent is owned by host host-a");
    await reader.closeAgent(agentId);
    await reader.flush();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  } finally {
    detachPersistence?.();
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["load", "history", "interactive"] as const)(
  "keeps a closed foreign agent read-only on %s",
  async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-closed-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
    const client = createPurposeCapturingClient(resumeOptions);
    const owner = new AgentManager({
      clients: { codex: client },
      registry: storage,
      serverId: "host-a",
      logger,
    });
    const reader = new AgentManager({
      clients: { codex: client },
      registry: storage,
      serverId: "host-b",
      logger,
    });
    const agentId = "00000000-0000-4000-8000-000000000304";
    const detachPersistence = attachAgentStoragePersistence(logger, reader, storage, "host-b");

    try {
      await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
        workspaceId: "workspace-foreign",
      });
      await owner.closeAgent(agentId);
      const stored = await storage.getFresh(agentId);
      if (!stored?.persistence) throw new Error("expected a persisted agent");

      const loaded =
        operation === "load"
          ? await ensureAgentLoaded(agentId, {
              agentManager: reader,
              agentStorage: storage,
              logger,
            })
          : await reader.resumeAgentFromPersistence(
              stored.persistence,
              { cwd: root },
              agentId,
              undefined,
              { purpose: operation },
            );
      await reader.flush();
      await storage.flush();

      expect(resumeOptions).toEqual([{ purpose: "history" }]);
      expect(loaded.hostId).toBe("host-a");
      expect(toAgentPayload(loaded).status).toBe("closed");
      await expect(reader.runAgent(agentId, "do not execute remotely")).rejects.toThrow(
        "agent is owned by host host-a",
      );
      expect(await storage.getFresh(agentId)).toEqual(stored);
    } finally {
      detachPersistence();
      await Promise.all([owner.closeAgent(agentId), reader.closeAgent(agentId)]);
      await Promise.all([owner.flush(), reader.flush(), storage.flush()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("projects owner closure on rescan without taking ownership of foreign history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-rescan-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client = createPurposeCapturingClient(resumeOptions);
  const owner = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000305";
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);

  try {
    await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected stored foreign agent");
    }
    await storage.upsert({ ...stored, lastStatus: "running" });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    expect(loaded.hostId).toBe("host-a");
    expect(resumeOptions).toEqual([{ purpose: "history" }]);

    // The owner closes the agent; the shared record now says closed.
    await storage.upsert({ ...stored, lastStatus: "closed" });

    // Closing the owner's runtime changes the projection, not execution ownership.
    now.mockReturnValue(20_000);
    await storage.list();
    await reader.flush();
    expect(reader.getAgent(agentId)?.hostId).toBe("host-a");

    const reread = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    await reader.flush();
    await storage.flush();

    expect(resumeOptions).toEqual([{ purpose: "history" }]);
    expect(toAgentPayload(reread).status).toBe("closed");
    expect(await storage.getFresh(agentId)).toMatchObject({
      hostId: "host-a",
      lastStatus: "closed",
    });
    await expect(reader.tryRunOutOfBand(agentId, "do not execute remotely")).rejects.toThrow(
      "agent is owned by host host-a",
    );
  } finally {
    now.mockRestore();
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes a resident foreign lifecycle projection without persisting it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-projection-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const client = createPurposeCapturingClient([]);
  const owner = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000307";
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);

  try {
    await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) throw new Error("expected stored foreign agent");
    await storage.upsert({ ...stored, lastStatus: "running" });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    expect(toAgentPayload(loaded).status).toBe("running");

    await storage.upsert({ ...stored, lastStatus: "idle" });
    const applySnapshot = vi.spyOn(storage, "applySnapshot");
    const upsert = vi.spyOn(storage, "upsert");
    const projectedStatuses: string[] = [];
    const unsubscribe = reader.subscribe((event) => {
      if (event.type === "agent_state" && event.agent.id === agentId) {
        projectedStatuses.push(toAgentPayload(event.agent).status);
      }
    });

    now.mockReturnValue(20_000);
    await storage.list();
    await reader.flush();
    unsubscribe();

    const resident = reader.getAgent(agentId);
    expect(resident).not.toBeNull();
    expect(resident && toAgentPayload(resident).status).toBe("idle");
    expect(projectedStatuses).toContain("idle");
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects foreign history for a provider without read-only history support", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-provider-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const client = createTestAgentClient("opencode");
  const owner = new AgentManager({
    clients: { opencode: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { opencode: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000308";

  try {
    await owner.createAgent({ provider: "opencode", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) throw new Error("expected stored foreign agent");
    await storage.upsert({ ...stored, lastStatus: "running" });

    await expect(
      ensureAgentLoaded(agentId, {
        agentManager: reader,
        agentStorage: storage,
        logger,
      }),
    ).rejects.toThrow("provider opencode does not support read-only history on this host");
    expect(reader.getAgent(agentId)).toBeNull();
  } finally {
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps resident foreign history read-only after the owner closes without a rescan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-reload-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client = createPurposeCapturingClient(resumeOptions);
  const owner = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000306";

  try {
    await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected stored foreign agent");
    }
    await storage.upsert({ ...stored, lastStatus: "running" });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    expect(loaded.hostId).toBe("host-a");
    expect(resumeOptions).toEqual([{ purpose: "history" }]);

    // The owner closes the agent while the reader's copy stays resident and
    // no rescan runs: the loader itself must re-read the record.
    await storage.upsert({ ...stored, lastStatus: "closed" });

    const reread = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    await reader.flush();
    await storage.flush();

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "history" }]);
    expect(reread.hostId).toBe("host-a");
    expect(toAgentPayload(reread).status).toBe("closed");
    expect(await storage.getFresh(agentId)).toMatchObject({
      hostId: "host-a",
      lastStatus: "closed",
    });
    await expect(reader.runAgent(agentId, "do not execute remotely")).rejects.toThrow(
      "agent is owned by host host-a",
    );
  } finally {
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects label writes for a resident foreign agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-foreign-labels-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const client = createTestAgentClients().codex;
  if (!client) {
    throw new Error("expected Codex test client");
  }
  const owner = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-a",
    logger,
  });
  const reader = new AgentManager({
    clients: { codex: client },
    registry: storage,
    serverId: "host-b",
    logger,
  });
  const agentId = "00000000-0000-4000-8000-000000000307";

  try {
    await owner.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-foreign",
    });
    await owner.closeAgent(agentId);
    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected stored foreign agent");
    }
    await storage.upsert({ ...stored, lastStatus: "running" });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: reader,
      agentStorage: storage,
      logger,
    });
    expect(loaded.hostId).toBe("host-a");

    await expect(reader.setLabels(agentId, { surface: "mobile" })).rejects.toThrow(
      "agent is owned by host host-a",
    );
    await expect(
      reader.updateAgentMetadata(agentId, { labels: { surface: "mobile" } }),
    ).rejects.toThrow("agent is owned by host host-a");
    expect((await storage.get(agentId))?.labels).toEqual(stored.labels);
  } finally {
    await Promise.all([
      owner.closeAgent(agentId).catch(() => undefined),
      reader.closeAgent(agentId).catch(() => undefined),
    ]);
    await owner.flush().catch(() => undefined);
    await reader.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("connection metadata from a resumed provider does not move the last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-metadata-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: createMetadataOnSubscribeClient() },
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000402";
  const lastActive = "2026-01-02T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {});
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    await storage.upsert({ ...stored, updatedAt: lastActive, lastActivityAt: lastActive });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // OMP reads context usage as soon as a resumed session is subscribed. The resulting
    // `usage_updated` event is not activity; stamping it rewrites the workspace timestamp.
    const resumed = await storage.get(agentId);
    expect(resumed?.updatedAt).toBe(lastActive);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(lastActive);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads an archived agent's history after its working directory is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const worktree = path.join(root, "managed-worktree");
  await mkdir(worktree, { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000501";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
      workspaceId: "workspace-worktree",
    });
    await startAgentRun(manager, agent.id, "what did you change", logger, {});
    // Dispatching a run does not finish it: the provider appends the reply to its
    // history afterwards, and the turn is finalized only once that append lands.
    // Archive after the turn is finalized so the transcript this test reads back is
    // already on disk when the worktree goes away.
    const finished = await manager.waitForAgentEvent(agent.id);
    expect(finished.status).toBe("idle");
    await manager.archiveAgent(agent.id);
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    // Archiving the workspace removes the worktree it owned. The agent's history is
    // persisted and reading it must not depend on that directory still being there.
    await rm(worktree, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
