import { expect, test, vi } from "vitest";

import {
  createDaemonInstanceHeartbeatErrorHandler,
  createScheduleLocalWorkspaceHandler,
  fanOutReconciledWorkspaceUpdates,
} from "./bootstrap.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

test("scheduled local workspace creation rejects a cwd owned by another host", async () => {
  const foreignWorkspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-foreign",
    projectId: "project-foreign",
    cwd: "/repo/foreign",
    kind: "directory",
    displayName: "foreign",
    hostId: "srv-other",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const createWorkspaceForDirectory = vi.fn();
  const scheduleForDirectory = vi.fn();
  const emitWorkspaceUpdates = vi.fn();
  const createWorkspace = createScheduleLocalWorkspaceHandler({
    workspaceRegistry: { list: async () => [foreignWorkspace] },
    serverId: "srv-local",
    workspaceProvisioning: { createWorkspaceForDirectory },
    workspaceAutoName: { scheduleForDirectory },
    emitWorkspaceUpdates,
  });

  await expect(
    createWorkspace({ cwd: "/repo/foreign", firstAgentContext: { prompt: "Run locally" } }),
  ).rejects.toThrow("Workspace ws-foreign is owned by host srv-other");
  expect(createWorkspaceForDirectory).not.toHaveBeenCalled();
  expect(scheduleForDirectory).not.toHaveBeenCalled();
  expect(emitWorkspaceUpdates).not.toHaveBeenCalled();
});

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});

test("daemon instance heartbeat stops after three failures in one heartbeat window", () => {
  let currentTime = 0;
  const shutdown = vi.fn();
  const logger = { error: vi.fn(), fatal: vi.fn() };
  const onError = createDaemonInstanceHeartbeatErrorHandler({
    serverId: "srv_test",
    logger,
    shutdown,
    now: () => currentTime,
  });

  onError(new Error("EACCES"));
  currentTime += 30_000;
  onError(new Error("NFS unavailable"));
  currentTime += 30_000;
  onError(new Error("EIO"));

  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(logger.fatal).toHaveBeenCalledWith(
    expect.objectContaining({ serverId: "srv_test", consecutiveFailures: 3 }),
    expect.stringContaining("failed repeatedly"),
  );
});

test("daemon instance heartbeat drops failures outside the bounded window", () => {
  let currentTime = 0;
  const shutdown = vi.fn();
  const onError = createDaemonInstanceHeartbeatErrorHandler({
    serverId: "srv_test",
    logger: { error: vi.fn(), fatal: vi.fn() },
    shutdown,
    now: () => currentTime,
  });

  onError(new Error("first"));
  currentTime += 90_000;
  onError(new Error("second"));
  currentTime += 30_000;
  onError(new Error("third"));

  expect(shutdown).not.toHaveBeenCalled();
});
