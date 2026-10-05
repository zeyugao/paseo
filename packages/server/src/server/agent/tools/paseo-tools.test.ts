import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./paseo-tools.js";

const TIMESTAMP = "2026-03-01T12:00:00.000Z";

function createWorkspaceRecord(hostId?: string): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: hostId ? "ws-foreign" : "ws-legacy",
    projectId: "proj-1",
    cwd: "/repo",
    kind: "local_checkout",
    displayName: "main",
    ...(hostId ? { hostId } : {}),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

function createCatalogForWorkspaces(
  workspaces: PersistedWorkspaceRecord[],
  overrides?: Partial<PaseoToolHostDependencies>,
) {
  const records = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const upsert = vi.fn(async (record: PersistedWorkspaceRecord) => {
    records.set(record.workspaceId, record);
  });
  const update = vi.fn(
    async (
      workspaceId: string,
      updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ) => {
      const existing = records.get(workspaceId);
      if (!existing) return null;
      const updated = updater(existing);
      records.set(workspaceId, updated);
      return updated;
    },
  );
  const workspaceRegistry = {
    get: async (workspaceId: string) => records.get(workspaceId) ?? null,
    list: async () => Array.from(records.values()),
    update,
    upsert,
  } as unknown as PaseoToolHostDependencies["workspaceRegistry"];
  const workspaceScripts = {
    list: vi.fn(async () => []),
    launch: vi.fn(async () => ({ name: "dev" })),
    stop: vi.fn(async () => ({ name: "dev" })),
  };
  const catalog = createPaseoToolCatalog({
    agentManager: {} as unknown as AgentManager,
    agentStorage: {} as unknown as AgentStorage,
    providerSnapshotManager: {} as unknown as ProviderSnapshotManager,
    logger: createTestLogger(),
    serverId: "srv-local",
    workspaceRegistry,
    workspaceScripts,
    emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    ...overrides,
  });
  return { catalog, workspaceScripts, upsert, update, records };
}

describe("paseo tools workspace ownership", () => {
  test("rename_workspace rejects a workspace owned by another host", async () => {
    const foreign = createWorkspaceRecord("srv-other");
    const { catalog, upsert } = createCatalogForWorkspaces([foreign]);

    await expect(
      catalog.executeTool("rename_workspace", { workspaceId: foreign.workspaceId, title: "X" }),
    ).rejects.toThrow("owned by host srv-other");
    expect(upsert).not.toHaveBeenCalled();
  });

  test("rename_workspace still renames a legacy workspace without a host", async () => {
    const legacy = createWorkspaceRecord();
    const { catalog, update, records } = createCatalogForWorkspaces([legacy]);

    const result = await catalog.executeTool("rename_workspace", {
      workspaceId: legacy.workspaceId,
      title: "Renamed",
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(records.get(legacy.workspaceId)).toMatchObject({ title: "Renamed" });
    expect(result.structuredContent).toMatchObject({
      success: true,
      workspaceId: legacy.workspaceId,
      title: "Renamed",
    });
  });

  test("rename_workspace merges into concurrent registry updates instead of overwriting them", async () => {
    const stale = createWorkspaceRecord();
    const concurrent = {
      ...stale,
      labels: ["concurrent"],
      pinnedAt: "2026-03-02T00:00:00.000Z",
    };
    const upsert = vi.fn(async () => {});
    let renamed: PersistedWorkspaceRecord | null = null;
    const update = vi.fn(
      async (
        workspaceId: string,
        updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
      ) => {
        renamed = updater(concurrent);
        return renamed;
      },
    );
    const catalog = createPaseoToolCatalog({
      agentManager: {} as unknown as AgentManager,
      agentStorage: {} as unknown as AgentStorage,
      providerSnapshotManager: {} as unknown as ProviderSnapshotManager,
      logger: createTestLogger(),
      serverId: "srv-local",
      workspaceRegistry: {
        // get() serves the snapshot fetched before another host wrote;
        // update() must apply the rename to the current record instead.
        get: async () => stale,
        list: async () => [concurrent],
        update,
        upsert,
      } as unknown as PaseoToolHostDependencies["workspaceRegistry"],
      emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    });

    await catalog.executeTool("rename_workspace", {
      workspaceId: stale.workspaceId,
      title: "Renamed",
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(renamed).toMatchObject({
      title: "Renamed",
      labels: ["concurrent"],
      pinnedAt: "2026-03-02T00:00:00.000Z",
    });
  });

  test("create_workspace worktree isolation rejects a source checkout owned by another host", async () => {
    const foreign = createWorkspaceRecord("srv-other");
    const createPaseoWorktree = vi.fn(async () => {
      throw new Error("worktree workflow must not run for a foreign source");
    });
    const { catalog } = createCatalogForWorkspaces([foreign], { createPaseoWorktree });

    await expect(
      catalog.executeTool("create_workspace", {
        isolation: "worktree",
        path: foreign.cwd,
        worktreeSlug: "blocked",
      }),
    ).rejects.toThrow("owned by host srv-other");
    expect(createPaseoWorktree).not.toHaveBeenCalled();
  });

  test("create_workspace local isolation rejects a path owned by another host", async () => {
    const foreign = { ...createWorkspaceRecord("srv-other"), cwd: process.cwd() };
    const createDirectoryWorkspace = vi.fn(async () => foreign);
    const { catalog } = createCatalogForWorkspaces([foreign], { createDirectoryWorkspace });

    await expect(
      catalog.executeTool("create_workspace", {
        isolation: "local",
        path: foreign.cwd,
      }),
    ).rejects.toThrow("owned by host srv-other");
    expect(createDirectoryWorkspace).not.toHaveBeenCalled();
  });

  test("archive_workspace rejects a workspace owned by another host", async () => {
    const foreign = createWorkspaceRecord("srv-other");
    const archiveWorkspaceRecord = vi.fn(async () => undefined);
    const { catalog } = createCatalogForWorkspaces([foreign], {
      listActiveWorkspaces: async () => [foreign],
      archiveWorkspaceRecord,
    });

    await expect(
      catalog.executeTool("archive_workspace", { workspaceId: foreign.workspaceId }),
    ).rejects.toThrow("owned by host srv-other");
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
  });

  test("archive_workspace gates archived backing paths owned by another host", async () => {
    const cwd = "/foreign-archive-worktree";
    const foreign = { ...createWorkspaceRecord("srv-other"), cwd };
    const archived = {
      ...createWorkspaceRecord("srv-local"),
      workspaceId: "ws-archived",
      cwd,
      archivedAt: "2026-03-02T00:00:00.000Z",
    };
    const archiveWorkspaceRecord = vi.fn(async () => undefined);
    const catalog = createCatalogForWorkspaces([foreign], {
      workspaceRegistry: {
        get: async (workspaceId: string) =>
          workspaceId === archived.workspaceId ? archived : null,
        list: async () => [foreign],
        update: vi.fn(),
        upsert: vi.fn(),
      } as unknown as PaseoToolHostDependencies["workspaceRegistry"],
      listActiveWorkspaces: async () => [archived],
      listAllActiveWorkspaces: async () => [],
      archiveWorkspaceRecord,
      emitWorkspaceUpdatesForWorkspaceIds: async () => {},
      markWorkspaceArchiving: () => {},
      clearWorkspaceArchiving: () => {},
      findWorkspaceIdForCwd: async () => archived.workspaceId,
      github: { invalidate: vi.fn() } as never,
      workspaceGitService: {
        getSnapshot: vi.fn(async () => undefined),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => null),
      },
    }).catalog;

    await expect(
      catalog.executeTool("archive_workspace", { workspaceId: archived.workspaceId }),
    ).rejects.toThrow("owned by host srv-other");
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
  });

  test("create_agent top-level implicit cwd rejects a foreign workspace before minting", async () => {
    const foreign = { ...createWorkspaceRecord("srv-other"), cwd: process.cwd() };
    const ensureWorkspaceForCreate = vi.fn(async () => "ws-created");
    const { catalog } = createCatalogForWorkspaces([foreign], { ensureWorkspaceForCreate });

    await expect(
      catalog.executeTool("create_agent", {
        title: "Blocked",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("owned by host srv-other");
    expect(ensureWorkspaceForCreate).not.toHaveBeenCalled();
  });
  test("create_agent rejects an inherited cwd owned by another host", async () => {
    const foreign = createWorkspaceRecord("srv-other");
    const caller = {
      id: "foreign-caller",
      cwd: foreign.cwd,
      workspaceId: "ws-caller-stale",
      provider: "codex",
      config: { provider: "codex", cwd: foreign.cwd },
    };
    const createAgent = vi.fn();
    const { catalog } = createCatalogForWorkspaces([foreign], {
      callerAgentId: caller.id,
      agentManager: {
        getAgent: (agentId: string) => (agentId === caller.id ? caller : null),
        createAgent,
      } as unknown as AgentManager,
    });

    await expect(
      catalog.executeTool("create_agent", {
        title: "Blocked child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("owned by host srv-other");
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("create_agent directory placement rejects a foreign workspace before minting", async () => {
    const foreign = { ...createWorkspaceRecord("srv-other"), cwd: process.cwd() };
    const ensureWorkspaceForCreate = vi.fn(async () => "ws-created");
    const { catalog } = createCatalogForWorkspaces([foreign], { ensureWorkspaceForCreate });

    await expect(
      catalog.executeTool("create_agent", {
        title: "Blocked",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
        relationship: { kind: "detached" },
        workspace: { kind: "create", source: { kind: "directory", path: process.cwd() } },
      }),
    ).rejects.toThrow("owned by host srv-other");
    expect(ensureWorkspaceForCreate).not.toHaveBeenCalled();
  });

  test.each(["list_workspace_scripts", "start_workspace_script", "stop_workspace_script"])(
    "%s rejects a workspace owned by another host",
    async (tool) => {
      const foreign = createWorkspaceRecord("srv-other");
      const { catalog, workspaceScripts } = createCatalogForWorkspaces([foreign]);

      await expect(
        catalog.executeTool(tool, { workspaceId: foreign.workspaceId, scriptName: "dev" }),
      ).rejects.toThrow("owned by host srv-other");
      expect(workspaceScripts.list).not.toHaveBeenCalled();
      expect(workspaceScripts.launch).not.toHaveBeenCalled();
      expect(workspaceScripts.stop).not.toHaveBeenCalled();
    },
  );

  test("start_workspace_script still runs against a workspace owned by this host", async () => {
    const own = createWorkspaceRecord("srv-local");
    const { catalog, workspaceScripts } = createCatalogForWorkspaces([own]);

    await catalog.executeTool("start_workspace_script", {
      workspaceId: own.workspaceId,
      scriptName: "dev",
    });

    expect(workspaceScripts.launch).toHaveBeenCalledWith({
      workspaceId: own.workspaceId,
      scriptName: "dev",
    });
  });
});
