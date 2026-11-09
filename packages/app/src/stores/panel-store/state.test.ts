import { subscribeMobilePanelSelection } from "@/mobile-panels/selection";
import { beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from ".";
import {
  DEFAULT_TREE_RAIL_WIDTH,
  migratePanelState,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
  setMobilePanelTarget,
  type PanelCoreState,
} from "./state";

function makePanelState(overrides: Partial<PanelCoreState> = {}): PanelCoreState {
  return {
    mobilePanel: { target: "agent", revision: 0 },
    desktop: {
      agentListOpen: false,
      focusModeEnabled: false,
    },
    layout: { isCompact: false, leftSidebar: "dock", leftDockAvailable: true },
    ...overrides,
  };
}

describe("panel-store migration", () => {
  it("defaults hidden-file visibility to showing hidden files", () => {
    const state = migratePanelState({}, 10);

    expect(state.explorerShowHiddenFiles).toBe(true);
  });

  it("initializes diffCollapsedFoldersByWorkspace for pre-v12 state", () => {
    const state = migratePanelState({}, 11);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({});
  });

  it("preserves an existing diffCollapsedFoldersByWorkspace map", () => {
    const state = migratePanelState({ diffCollapsedFoldersByWorkspace: { ws: ["src/app"] } }, 12);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({ ws: ["src/app"] });
  });

  it("initializes and preserves collapsed diff file paths by workspace", () => {
    expect(migratePanelState({}, 14).collapsedFilePathsByWorkspace).toEqual({});
    expect(
      migratePanelState({ collapsedFilePathsByWorkspace: { ws: ["src/app.ts"] } }, 14)
        .collapsedFilePathsByWorkspace,
    ).toEqual({ ws: ["src/app.ts"] });
  });

  it("drops the retired per-file diff expansion state", () => {
    const state = migratePanelState({ diffExpandedPathsByWorkspace: { ws: ["src/app.ts"] } }, 13);

    expect(state.diffExpandedPathsByWorkspace).toBeUndefined();
  });

  it("replaces the dead explorer split ratio with the shared tree rail width", () => {
    const state = migratePanelState({ explorerFilesSplitRatio: 0.5 }, 12);

    expect(state.explorerFilesSplitRatio).toBeUndefined();
    expect(state.treeRailWidth).toBe(DEFAULT_TREE_RAIL_WIDTH);
  });

  it("narrows an existing install's tree rail to the new default width", () => {
    expect(DEFAULT_TREE_RAIL_WIDTH).toBeLessThan(320);
    expect(migratePanelState({ treeRailWidth: 320 }, 15).treeRailWidth).toBe(
      DEFAULT_TREE_RAIL_WIDTH,
    );
  });

  it("defaults the file panel tree to open and keeps it closed once closed", () => {
    expect(migratePanelState({}, 15).fileTreeVisible).toBe(true);
    expect(migratePanelState({ fileTreeVisible: false }, 16).fileTreeVisible).toBe(false);
  });

  it("drops persisted compact panel state so cold starts return to content", () => {
    const state = migratePanelState(
      { mobileView: "agent-list", mobilePanel: { target: "file-explorer", revision: 42 } },
      11,
    );

    expect(state.mobileView).toBeUndefined();
    expect(state.mobilePanel).toBeUndefined();
  });
});

describe("panel-store visibility selectors", () => {
  it("increments the mobile panel revision only when the target changes", () => {
    const initial = { target: "agent" as const, revision: 4 };

    expect(setMobilePanelTarget(initial, "agent")).toBe(initial);
    expect(setMobilePanelTarget(initial, "agent-list")).toEqual({
      target: "agent-list",
      revision: 5,
    });
  });

  it("uses the mobile panel target for compact layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, focusModeEnabled: false },
      layout: { isCompact: true, leftSidebar: "overlay", leftDockAvailable: false },
    });

    expect(selectIsAgentListOpen(state)).toBe(false);
    expect(selectIsCompactFileExplorerOpen(state)).toBe(true);
  });

  it("uses the desktop flag for the expanded agent list", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, focusModeEnabled: false },
    });

    expect(selectIsAgentListOpen(state)).toBe(true);
  });
});

it("discards obsolete checkout selection while preserving other panel preferences", () => {
  const state = migratePanelState(
    { explorerTab: "files", explorerTabByCheckout: { checkout: "changes" }, sidebarWidth: 400 },
    16,
  );
  expect(state).not.toHaveProperty("explorerTab");
  expect(state).not.toHaveProperty("explorerTabByCheckout");
  expect(state.sidebarWidth).toBe(400);
});

describe("panel-store wide navigation overlay", () => {
  it("subscribes with the current selection and observes future commands until unsubscribe", () => {
    usePanelStore.getState().showMobileAgent();
    usePanelStore
      .getState()
      .applyPanelLayout({ isCompact: false, leftSidebar: "hidden", leftDockAvailable: false });
    const published = usePanelStore.getState().mobilePanel;
    const received: (typeof published)[] = [];
    const unsubscribe = subscribeMobilePanelSelection((selection) => received.push(selection));
    try {
      expect(received).toEqual([published]);
      usePanelStore.getState().showMobileAgentList();
      expect(received).toEqual([published, usePanelStore.getState().mobilePanel]);
      unsubscribe();
      const before = [...received];
      usePanelStore.getState().showMobileAgent();
      expect(received).toEqual(before);
    } finally {
      unsubscribe();
    }
  });

  beforeEach(() => {
    const panels = usePanelStore.getState();
    panels.exitFocusMode();
    panels.applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });
    panels.showMobileAgent();
    panels.closeDesktopAgentList();
  });

  it.each([
    ["openDesktopAgentList", () => usePanelStore.getState().openDesktopAgentList()],
    ["toggleDesktopAgentList", () => usePanelStore.getState().toggleDesktopAgentList()],
  ])("drops the overlay target when %s docks the sidebar", (_name, dock) => {
    usePanelStore.getState().showMobileAgentList();

    dock();

    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it.each([false, true])(
    "operates a yielded overlay without changing saved dock intent %s",
    (savedOpen) => {
      const panels = usePanelStore.getState();
      if (savedOpen) panels.openDesktopAgentList();
      panels.applyPanelLayout({
        isCompact: false,
        leftSidebar: "overlay",
        leftDockAvailable: false,
      });

      panels.openAgentListForLayout();
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(true);
      panels.closeAgentListForLayout();
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(false);
      panels.toggleAgentListForLayout();
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
      panels.toggleAgentListForLayout();
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
      expect(usePanelStore.getState().desktop.agentListOpen).toBe(savedOpen);

      panels.openAgentListForLayout();
      panels.applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(savedOpen);
    },
  );

  it("opens a collapsed dock when the shell has room rather than opening its overlay", () => {
    const panels = usePanelStore.getState();
    panels.applyPanelLayout({ isCompact: false, leftSidebar: "overlay", leftDockAvailable: true });
    panels.toggleAgentListForLayout();
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("closes a swipe-open dockable overlay before reopening the dock", () => {
    const panels = usePanelStore.getState();
    panels.applyPanelLayout({ isCompact: false, leftSidebar: "overlay", leftDockAvailable: true });
    panels.showMobileAgentList();
    expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(true);
    panels.openAgentListForLayout();
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(false);
    panels.toggleAgentListForLayout();
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(false);
    panels.toggleAgentListForLayout();
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
  });

  it("ignores navigation commands while chrome is hidden", () => {
    const panels = usePanelStore.getState();
    panels.applyPanelLayout({ isCompact: false, leftSidebar: "hidden", leftDockAvailable: false });
    panels.openAgentListForLayout();
    panels.toggleAgentListForLayout();
    panels.closeAgentListForLayout();
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(false);
    expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(false);
  });

  it.each([
    { action: "openAgentListForLayout", leftSidebar: "dock", leftDockAvailable: true },
    { action: "toggleAgentListForLayout", leftSidebar: "dock", leftDockAvailable: true },
    { action: "openAgentListForLayout", leftSidebar: "overlay", leftDockAvailable: false },
    { action: "toggleAgentListForLayout", leftSidebar: "overlay", leftDockAvailable: false },
  ] as const)(
    "exits focus and restores navigation through $action before $leftSidebar publishes",
    ({ action, leftSidebar, leftDockAvailable }) => {
      const panels = usePanelStore.getState();
      panels.toggleFocusMode();
      panels.applyPanelLayout({
        isCompact: false,
        leftSidebar: "hidden",
        leftDockAvailable: false,
      });
      const revision = usePanelStore.getState().mobilePanel.revision;
      const transitions: { focusModeEnabled: boolean; agentListOpen: boolean; target: string }[] =
        [];
      const unsubscribe = usePanelStore.subscribe((state) => {
        transitions.push({ ...state.desktop, target: state.mobilePanel.target });
      });

      try {
        panels[action]();
        panels.exitFocusMode();
      } finally {
        unsubscribe();
      }

      expect(transitions).toEqual([
        { focusModeEnabled: false, agentListOpen: true, target: "agent-list" },
      ]);
      expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(revision);
      panels.applyPanelLayout({ isCompact: false, leftSidebar, leftDockAvailable });
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(true);
      expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
      expect(usePanelStore.getState().mobilePanel.target).toBe(
        leftSidebar === "dock" ? "agent" : "agent-list",
      );
    },
  );

  it.each([false, true])(
    "opens compact navigation from focus without changing saved dock intent %s",
    (savedOpen) => {
      const panels = usePanelStore.getState();
      if (savedOpen) panels.openDesktopAgentList();
      panels.applyPanelLayout({
        isCompact: true,
        leftSidebar: "overlay",
        leftDockAvailable: false,
      });
      panels.showMobileFileExplorer();
      panels.toggleFocusMode();
      panels.applyPanelLayout({ isCompact: true, leftSidebar: "hidden", leftDockAvailable: false });
      const revision = usePanelStore.getState().mobilePanel.revision;

      panels.openAgentListForLayout();

      expect(usePanelStore.getState().desktop).toEqual({
        agentListOpen: savedOpen,
        focusModeEnabled: false,
      });
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");
      expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(revision);
      panels.exitFocusMode();
      panels.applyPanelLayout({
        isCompact: true,
        leftSidebar: "overlay",
        leftDockAvailable: false,
      });
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(true);
      expect(usePanelStore.getState().desktop.agentListOpen).toBe(savedOpen);

      panels.applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });
      expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(savedOpen);
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    },
  );

  it.each([false, true])(
    "collapses navigation and invalidates opening gestures on compact=%s",
    (isCompact) => {
      const panels = usePanelStore.getState();
      panels.openDesktopAgentList();
      panels.applyPanelLayout({ isCompact, leftSidebar: "overlay", leftDockAvailable: false });
      if (isCompact) panels.showMobileFileExplorer();
      const revision = usePanelStore.getState().mobilePanel.revision;
      panels.collapseAgentListForLayout();
      expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(revision);
      expect(usePanelStore.getState().mobilePanel.target).toBe(
        isCompact ? "file-explorer" : "agent",
      );
      expect(usePanelStore.getState().desktop.agentListOpen).toBe(isCompact);
    },
  );

  it("drops the overlay target once the sidebar is no longer presented as an overlay", () => {
    usePanelStore.getState().showMobileAgentList();
    usePanelStore
      .getState()
      .applyPanelLayout({ isCompact: false, leftSidebar: "overlay", leftDockAvailable: false });
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent-list");

    usePanelStore
      .getState()
      .applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");

    usePanelStore.getState().showMobileAgentList();
    usePanelStore
      .getState()
      .applyPanelLayout({ isCompact: false, leftSidebar: "hidden", leftDockAvailable: false });
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it.each(["dock", "hidden"] as const)(
    "invalidates an opening swipe when presentation becomes %s before its target commits",
    (presentation) => {
      usePanelStore
        .getState()
        .applyPanelLayout({ isCompact: false, leftSidebar: "overlay", leftDockAvailable: false });
      const startedRevision = usePanelStore.getState().mobilePanel.revision;
      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");

      usePanelStore.getState().applyPanelLayout({
        isCompact: false,
        leftSidebar: presentation,
        leftDockAvailable: presentation === "dock",
      });

      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
      expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(startedRevision);
    },
  );

  it.each(["overlay", "hidden"] as const)(
    "keeps the compact explorer target when the compact sidebar becomes %s",
    (leftSidebar) => {
      usePanelStore.getState().showMobileFileExplorer();

      usePanelStore
        .getState()
        .applyPanelLayout({ isCompact: true, leftSidebar, leftDockAvailable: false });

      expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    },
  );

  it.each(["overlay", "dock", "hidden"] as const)(
    "drops the compact explorer target when the layout widens with a %s sidebar",
    (leftSidebar) => {
      usePanelStore.getState().showMobileFileExplorer();
      const openedRevision = usePanelStore.getState().mobilePanel.revision;

      usePanelStore.getState().applyPanelLayout({
        isCompact: false,
        leftSidebar,
        leftDockAvailable: leftSidebar === "dock",
      });

      expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
      expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(openedRevision);
    },
  );
});
