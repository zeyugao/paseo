import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import { selectSidebarAttentionBucket } from "@/utils/sidebar-attention";

function workspace(workspaceId: string, projectViewKey: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey,
    projectName: projectViewKey,
    projectRootPath: `/repo/${projectViewKey}`,
    workspaceDirectory: `/repo/${projectViewKey}/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt: null,
    labels: [],
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("resolveActiveProjectFilters", () => {
  test("reads an empty stored filter as every project", () => {
    expect(resolveActiveProjectFilters([], new Set(["alpha", "beta"]))).toEqual([]);
  });

  test("keeps only the keys that still name a project it can see", () => {
    expect(resolveActiveProjectFilters(["alpha", "gone"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
    ]);
    expect(resolveActiveProjectFilters(["alpha", "beta"], new Set(["alpha", "beta"]))).toEqual([
      "alpha",
      "beta",
    ]);
  });

  // Nothing deletes the stored keys, so a filter naming only projects on a host that has not
  // connected yet must go inert rather than blank the sidebar. It comes back with the host.
  test("goes inert instead of matching nothing", () => {
    expect(resolveActiveProjectFilters(["alpha"], new Set(["beta"]))).toEqual([]);
    expect(resolveActiveProjectFilters(["alpha"], new Set())).toEqual([]);
  });
});

describe("filterWorkspacesByProjects", () => {
  const workspaces = [
    workspace("one", "alpha"),
    workspace("two", "alpha"),
    workspace("three", "beta"),
  ];

  function filtered(projectFilters: string[]) {
    return filterWorkspacesByProjects({ workspaces, projectFilters }).map(
      (entry) => entry.workspaceId,
    );
  }

  test("keeps every workspace when nothing is pinned", () => {
    expect(filtered([])).toEqual(["one", "two", "three"]);
  });

  test("keeps the workspaces of the pinned projects", () => {
    expect(filtered(["alpha"])).toEqual(["one", "two"]);
    expect(filtered(["beta"])).toEqual(["three"]);
    expect(filtered(["alpha", "beta"])).toEqual(["one", "two", "three"]);
  });

  test("keeps nothing for a project with no workspaces", () => {
    expect(filtered(["gamma"])).toEqual([]);
  });
});

describe("collapsed sidebar attention", () => {
  const activeSelection = { serverId: "host", workspaceId: "current" };
  const current = { ...workspace("current", "alpha"), statusBucket: "needs_input" as const };
  const other = { ...workspace("other", "beta"), statusBucket: "attention" as const };
  const select = (overrides: Partial<Parameters<typeof selectSidebarAttentionBucket>[0]> = {}) =>
    selectSidebarAttentionBucket({
      sidebarOpen: false,
      workspaces: [current, other],
      availableProjectKeys: new Set(["alpha", "beta"]),
      projectFilters: [],
      labelFilter: { labels: [] },
      showBackground: false,
      activeSelection,
      ...overrides,
    });

  test("ignores the current workspace and suppresses the dot while open", () => {
    expect(select()).toBe("attention");
    expect(select({ workspaces: [current] })).toBeNull();
    expect(select({ sidebarOpen: true })).toBeNull();
    expect(select({ activeSelection: null })).toBe("needs_input");
  });

  test("matches current identity by host and workspace together", () => {
    expect(
      select({
        workspaces: [{ ...current, serverId: "other-host", workspaceKey: "other-host:current" }],
      }),
    ).toBe("needs_input");
  });

  test("uses attention priority without running masking review or failure", () => {
    const running = { ...workspace("running", "beta"), statusBucket: "running" as const };
    const failed = { ...workspace("failed", "beta"), statusBucket: "failed" as const };
    const needsInput = { ...workspace("input", "beta"), statusBucket: "needs_input" as const };
    expect(select({ workspaces: [running, other] })).toBe("attention");
    expect(select({ workspaces: [running, other, failed] })).toBe("failed");
    expect(select({ workspaces: [failed, needsInput, running] })).toBe("needs_input");
    expect(select({ workspaces: [running, workspace("done", "beta")] })).toBeNull();
  });

  test("respects project, label, and background filters", () => {
    expect(select({ projectFilters: ["alpha"] })).toBeNull();
    expect(select({ projectFilters: ["beta"] })).toBe("attention");
    expect(select({ projectFilters: ["removed"] })).toBe("attention");
    expect(select({ labelFilter: { labels: ["urgent"] } })).toBeNull();
    expect(
      select({
        workspaces: [{ ...other, labels: ["Urgent"] }],
        labelFilter: { labels: ["urgent"] },
      }),
    ).toBe("attention");
    expect(select({ workspaces: [{ ...other, background: true }] })).toBeNull();
    expect(select({ workspaces: [{ ...other, background: true }], showBackground: true })).toBe(
      "attention",
    );
  });
});
