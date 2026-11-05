import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      mutable: async () => true,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      mutable: async () => true,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.listAll()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared-home recovery never rewrites foreign running records and still resumes local agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-shared-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    const timestamp = "2026-01-01T00:00:00.000Z";
    for (const [id, hostId] of [
      ["foreign", "other"],
      ["local", "here"],
      ["transferred", "here"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          hostId,
          lastStatus: "running",
          resumeOnStartup: true,
          provider: "codex",
          cwd: root,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const foreign = await storage.getFresh("foreign");
    const writes = vi.spyOn(storage, "upsert");
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      mutable: async (record) => record.hostId === undefined || record.hostId === "here",
      settings: () => ({ enabled: true, prompt: "Continue." }),
      eligible: async () => true,
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    await recovery.prepareStartup();
    expect(await storage.getFresh("foreign")).toEqual(foreign);
    expect(await storage.getFresh("local")).toMatchObject({
      lastStatus: "closed",
      resumeOnStartup: true,
    });
    expect(writes.mock.calls.every(([record]) => record.id !== "foreign")).toBe(true);
    const transferred = { ...(await storage.getFresh("transferred"))!, hostId: "other" };
    await storage.upsert(transferred);
    writes.mockClear();
    recovery.resumePending();
    await recovery.waitForResume("local", new AbortController().signal);
    await recovery.waitForResume("transferred", new AbortController().signal);
    expect(dispatched).toEqual(["local"]);
    expect(await storage.getFresh("foreign")).toEqual(foreign);
    expect(await storage.getFresh("local")).toMatchObject({ resumeOnStartup: false });
    expect(await storage.getFresh("transferred")).toEqual(transferred);
    expect(writes.mock.calls.every(([record]) => record.id === "local")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
