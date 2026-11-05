import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import type { HeapProfiler } from "node:inspector";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    hostId: overrides.hostId,
    projectedLifecycle: overrides.projectedLifecycle,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("workspace and active queries follow updates, removal, and reload", async () => {
    const base = {
      provider: "codex",
      cwd: tmpDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {},
    };
    await storage.upsert({
      ...base,
      id: "a",
      workspaceId: "one",
      lastUserMessageAt: base.createdAt,
    });
    await storage.upsert({ ...base, id: "b", workspaceId: "two", archivedAt: base.createdAt });
    expect((await storage.listActive()).map((r) => r.id)).toEqual(["a"]);
    await storage.upsert({
      ...base,
      id: "a",
      workspaceId: "two",
      lastUserMessageAt: base.updatedAt,
    });
    expect(await storage.listByWorkspaces(["one"])).toEqual([]);
    expect((await storage.listByWorkspaces(["two"])).map((r) => r.id)).toEqual(["a"]);
    expect(
      (await storage.listByWorkspaces(["two"], { includeArchived: true })).map((r) => r.id).sort(),
    ).toEqual(["a", "b"]);
    expect(await storage.lastUserMessageAtByWorkspace(["one", "two"])).toEqual(
      new Map([["two", base.createdAt]]),
    );
    await storage.flush();
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    expect((await reloaded.listActive()).map((r) => r.id)).toEqual(["a"]);
    expect(
      await reloaded.lastUserMessageAtByWorkspace(["two"], { excludeAgentIds: ["a"] }),
    ).toEqual(new Map());
    await reloaded.remove("a");
    expect(await reloaded.listActive()).toEqual([]);
    expect(await reloaded.lastUserMessageAtByWorkspace(["two"])).toEqual(new Map());
  });

  test("single-agent lookups keep allocations bounded with a large stored history", async () => {
    await fs.mkdir(storagePath, { recursive: true });
    const record = {
      id: "history-0",
      provider: "codex",
      cwd: tmpDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      labels: {},
      lastStatus: "idle",
    };
    for (let offset = 0; offset < 2048; offset += 64) {
      await Promise.all(
        Array.from({ length: 64 }, (_, index) => {
          const id = `history-${offset + index}`;
          return fs.writeFile(
            path.join(storagePath, `${id}.json`),
            JSON.stringify({ ...record, id }),
          );
        }),
      );
    }
    await storage.initialize();
    expect(await storage.listAll()).toHaveLength(2048);
    const expected = await storage.get(record.id);
    expect(expected).toMatchObject(record);

    const inspector = new InspectorSession();
    inspector.connect();
    let allocatedBytes = 0;
    let matches = 0;
    try {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < 1000; index++) {
        if ((await storage.get(record.id)) === expected) matches++;
      }
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((bytes, child) => bytes + sum(child), 0);
      allocatedBytes = sum(profile.head);
    } finally {
      inspector.disconnect();
    }

    expect(matches).toBe(1000);
    // Copying this history on every lookup allocates >16 MiB. Allow generous
    // sampling/runtime overhead without relying on the host's execution speed.
    expect(allocatedBytes).toBeLessThan(4 * 1024 * 1024);
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.listAll();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const [persisted] = await reloaded.listAll();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.listAll();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.listAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, createTestLogger());
    const before = await reloaded.listAll();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, createTestLogger());
    const after = await afterReload.listAll();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
  test("persists optional host ownership", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "host-owned-agent", hostId: "host-a" }));

    const reloaded = new AgentStorage(storagePath, logger);
    await expect(reloaded.get("host-owned-agent")).resolves.toMatchObject({ hostId: "host-a" });
  });

  test("rescans stale listings for externally added and removed records", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const observer = new AgentStorage(storagePath, logger);
      const writer = new AgentStorage(storagePath, logger);
      await observer.initialize();

      await writer.applySnapshot(
        createManagedAgent({ id: "external-agent", cwd: "/tmp/external-project" }),
      );
      now.mockReturnValue(15_001);
      await expect(observer.listAll()).resolves.toMatchObject([{ id: "external-agent" }]);

      await writer.remove("external-agent");
      now.mockReturnValue(20_002);
      await expect(observer.listAll()).resolves.toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  test.each(["active", "workspaces", "promptTimes"] as const)(
    "refreshes shared workspace and background indexes through %s reads",
    async (read) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
      try {
        const observer = new AgentStorage(storagePath, logger);
        const writer = new AgentStorage(storagePath, logger);
        await observer.initialize();
        await writer.applySnapshot(
          createManagedAgent({
            id: "external-agent",
            workspaceId: "workspace-one",
            lastUserMessageAt: new Date("2025-01-01T00:00:00.000Z"),
          }),
        );
        const refresh = async () => {
          if (read === "active") await observer.listActive();
          else if (read === "workspaces")
            await observer.listByWorkspaces(["workspace-one", "workspace-two"]);
          else await observer.lastUserMessageAtByWorkspace();
        };

        now.mockReturnValue(15_001);
        await refresh();
        expect((await observer.listByWorkspaces(["workspace-one"])).map((r) => r.id)).toEqual([
          "external-agent",
        ]);
        expect(await observer.lastUserMessageAtByWorkspace()).toEqual(
          new Map([["workspace-one", "2025-01-01T00:00:00.000Z"]]),
        );

        const stored = await writer.get("external-agent");
        if (!stored) throw new Error("expected stored external agent");
        await writer.upsert({
          ...stored,
          workspaceId: "workspace-two",
          background: true,
          archivedAt: "2025-02-01T00:00:00.000Z",
        });
        now.mockReturnValue(20_002);
        await refresh();
        expect(await observer.listActive()).toEqual([]);
        expect(
          await observer.listByWorkspaces(["workspace-one"], { includeArchived: true }),
        ).toEqual([]);
        expect(
          (await observer.listByWorkspaces(["workspace-two"], { includeArchived: true })).map(
            (r) => r.id,
          ),
        ).toEqual(["external-agent"]);
        expect(await observer.lastUserMessageAtByWorkspace()).toEqual(new Map());

        await writer.remove("external-agent");
        now.mockReturnValue(25_003);
        await refresh();
        expect(await observer.listActive({ includeArchived: true })).toEqual([]);
        expect(
          await observer.listByWorkspaces(["workspace-two"], { includeArchived: true }),
        ).toEqual([]);
        expect(await observer.lastUserMessageAtByWorkspace()).toEqual(new Map());
      } finally {
        now.mockRestore();
      }
    },
  );

  test("getFresh reads external writes while get serves the cache", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const observer = new AgentStorage(storagePath, logger);
      const writer = new AgentStorage(storagePath, logger);
      await writer.applySnapshot(
        createManagedAgent({ id: "shared-agent", cwd: "/tmp/external-project" }),
      );
      await observer.initialize();

      const stored = await writer.get("shared-agent");
      if (!stored) {
        throw new Error("expected stored record");
      }
      await writer.upsert({ ...stored, title: "updated-externally", hostId: "host-b" });

      expect((await observer.get("shared-agent"))?.title).not.toBe("updated-externally");
      await expect(observer.getFresh("shared-agent")).resolves.toMatchObject({
        title: "updated-externally",
        hostId: "host-b",
      });
      // The fresh hit also refreshes the cached entry.
      expect((await observer.get("shared-agent"))?.title).toBe("updated-externally");

      await expect(observer.getFresh("missing-agent")).resolves.toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  test("getFresh waits for in-flight writes before reading from disk", async () => {
    await storage.applySnapshot(createManagedAgent({ id: "agent-pending" }));
    const internals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      writeRecord: (record: StoredAgentRecord) => Promise<void>;
    };
    const originalWriteRecord = internals.writeRecord.bind(storage);
    const writeGate = Promise.withResolvers<void>();
    vi.spyOn(internals, "writeRecord").mockImplementation(async (record) => {
      await writeGate.promise;
      return originalWriteRecord(record);
    });

    const write = storage.setTitle("agent-pending", "fresh-title");
    await vi.waitFor(() => {
      expect(internals.pendingWrites.has("agent-pending")).toBe(true);
    });

    // The write is gated mid-flight; a read that skipped the write queue
    // would observe the pre-write record.
    const freshPromise = storage.getFresh("agent-pending");
    writeGate.resolve();
    await expect(freshPromise).resolves.toMatchObject({ title: "fresh-title" });
    await write;
  });

  test("rescan keeps queued writes authoritative over stale scan data", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      await storage.applySnapshot(
        createManagedAgent({ id: "agent-race", cwd: "/tmp/race-project" }),
      );
      const base = await storage.get("agent-race");
      if (!base) {
        throw new Error("expected base record");
      }
      const archivedAt = "2025-02-01T00:00:00.000Z";

      type ScanResult = Array<{ record: StoredAgentRecord; filePath: string }>;
      const internals = storage as unknown as { scanDisk: () => Promise<ScanResult> };
      const originalScanDisk = internals.scanDisk.bind(storage);
      const staleScan = await originalScanDisk();

      let snapshot: Promise<void> | null = null;
      let intercepted = false;
      vi.spyOn(internals, "scanDisk").mockImplementation(async () => {
        if (intercepted) {
          return originalScanDisk();
        }
        intercepted = true;
        // Queue an archive and a trailing snapshot flush, let the archive
        // commit, then hand the rescan scan data from before it landed.
        const archived = storage.upsert({ ...base, archivedAt });
        snapshot = storage.applySnapshot(
          createManagedAgent({ id: "agent-race", cwd: "/tmp/race-project" }),
        );
        await archived;
        return staleScan;
      });

      now.mockReturnValue(20_000);
      await storage.listAll();
      await snapshot;
      await storage.flush();

      const reloaded = new AgentStorage(storagePath, logger);
      expect((await reloaded.get("agent-race"))?.archivedAt).toBe(archivedAt);
    } finally {
      now.mockRestore();
    }
  });
});
