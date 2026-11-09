import { beforeEach, describe, expect, it } from "vitest";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { toggleDesktopSidebarsWithCheckoutIntent } from "./desktop-sidebar-toggle";

function toggleWideSidebars(explorerVisible: boolean): boolean {
  const panel = usePanelStore.getState();
  let explorerOpen = explorerVisible;
  toggleDesktopSidebarsWithCheckoutIntent({
    isAgentListOpen: selectIsAgentListOpen(panel),
    isExplorerOpen: explorerOpen,
    openAgentList: panel.openAgentListForLayout,
    resetAgentList: panel.collapseAgentListForLayout,
    toggleExplorer: () => {
      explorerOpen = !explorerOpen;
    },
  });
  return explorerOpen;
}

beforeEach(() => {
  usePanelStore.setState({
    desktop: { agentListOpen: false, focusModeEnabled: false },
    mobilePanel: { target: "agent", revision: 0 },
    layout: { isCompact: false, leftSidebar: "overlay", leftDockAvailable: true },
  });
});

describe("toggleDesktopSidebarsWithCheckoutIntent", () => {
  it("opens navigation and Explorer when both are closed", () => {
    expect(toggleWideSidebars(false)).toBe(true);
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
  });

  it("opens both from focus before chrome republishes a docked layout", () => {
    const panel = usePanelStore.getState();
    panel.toggleFocusMode();
    panel.applyPanelLayout({ isCompact: false, leftSidebar: "hidden", leftDockAvailable: false });

    const explorerOpen = toggleWideSidebars(false);
    panel.exitFocusMode();
    panel.applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });

    expect(explorerOpen).toBe(true);
    expect(selectIsAgentListOpen(usePanelStore.getState())).toBe(true);
    expect(usePanelStore.getState().desktop).toEqual({
      agentListOpen: true,
      focusModeEnabled: false,
    });
  });

  it("collapses both when a dock is visible", () => {
    const panel = usePanelStore.getState();
    panel.openDesktopAgentList();
    panel.applyPanelLayout({ isCompact: false, leftSidebar: "dock", leftDockAvailable: true });
    expect(toggleWideSidebars(true)).toBe(false);
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(false);
  });

  it("clears deferred navigation intent when only Explorer is visible", () => {
    const panel = usePanelStore.getState();
    panel.openDesktopAgentList();
    panel.applyPanelLayout({ isCompact: false, leftSidebar: "overlay", leftDockAvailable: false });
    const revision = usePanelStore.getState().mobilePanel.revision;
    expect(toggleWideSidebars(true)).toBe(false);
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(false);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(usePanelStore.getState().mobilePanel.revision).toBeGreaterThan(revision);
  });

  it("closes the compact Explorer while preserving wide navigation intent", () => {
    const panel = usePanelStore.getState();
    panel.openDesktopAgentList();
    panel.applyPanelLayout({ isCompact: true, leftSidebar: "overlay", leftDockAvailable: false });
    panel.showMobileFileExplorer();
    toggleDesktopSidebarsWithCheckoutIntent({
      isAgentListOpen: selectIsAgentListOpen(usePanelStore.getState()),
      isExplorerOpen: true,
      openAgentList: panel.openAgentListForLayout,
      resetAgentList: panel.collapseAgentListForLayout,
      toggleExplorer: () => {
        if (usePanelStore.getState().mobilePanel.target === "file-explorer")
          panel.showMobileAgent();
        else panel.showMobileFileExplorer();
      },
    });
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(usePanelStore.getState().desktop.agentListOpen).toBe(true);
  });
});
