import { describe, expect, it } from "vitest";
import {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  type WindowLayout,
} from "@/window-layout";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarVisibility,
  resolveSidebarActivity,
  resolveDesktopSidebarWidth,
  resolveLeftSidebarPresentation,
} from "@/components/desktop-sidebar-layout";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";

describe("desktop sidebar layout", () => {
  const geometry: WindowLayout = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    insets: { top: 0, right: 84, bottom: 34, left: 0 },
    verticalBarEdge: "trailing",
    verticalBar: { x: 875, y: 160, width: 44, height: 450 },
    divisions: [{ x: 465, y: 0, width: 21, height: 669 }],
  };

  it("places workspace action symbols in the reported trailing bar", () => {
    expect(resolveWorkspaceActionPlacement(geometry)).toBe("vertical-bar");
    expect(resolveWorkspaceActionPlacement(null)).toBe("header");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBarEdge: "none" })).toBe(
      "header",
    );
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBar: null })).toBe("header");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBarEdge: "leading" })).toBe(
      "header",
    );
  });

  it("allocates both panels around a live division without clamping to saved sidebar widths", () => {
    const input = {
      geometry,
      windowWidth: 951,
      windowHeight: 669,
      leftInset: 0,
      rightInset: 84,
    };
    expect(resolveDesktopDivisionLayout(input)).toEqual({
      sidebarWidth: 465,
      gap: 21,
      contentWidth: 381,
    });
    expect(
      resolveDesktopDivisionLayout({ ...input, geometry: { ...geometry, divisions: [] } }),
    ).toBeNull();
    expect(
      resolveDesktopDivisionLayout({ ...input, windowWidth: 669, windowHeight: 951 }),
    ).toBeNull();
    expect(resolveDesktopDivisionLayout({ ...input, geometry: null })).toBeNull();
    expect(
      resolveDesktopDivisionLayout({
        ...input,
        geometry: { ...geometry, divisions: [{ x: 0, y: 325, width: 951, height: 19 }] },
      }),
    ).toBeNull();
  });

  it("activates a revealed folded sidebar while preserving closed desktop intent", () => {
    expect(resolveSidebarActivity(true, false, false)).toBe(true);
    expect(resolveSidebarActivity(false, false, false)).toBe(false);
    expect(resolveSidebarActivity(true, true, false)).toBe(false);
    expect(resolveSidebarActivity(true, true, true)).toBe(true);
  });

  it("temporarily reveals navigation for a division without changing the saved closed intent", () => {
    const visibility = {
      chromeEnabled: true,
      isCompactLayout: false,
      isMounted: true,
      isOpen: false,
      canShare: false,
    };
    expect(
      resolveDesktopSidebarVisibility({
        ...visibility,
        divisionLayout: { sidebarWidth: 465, gap: 21, contentWidth: 381 },
      }),
    ).toBe(true);
    expect(resolveDesktopSidebarVisibility({ ...visibility, divisionLayout: null })).toBe(false);
    expect(visibility.isOpen).toBe(false);
  });

  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("offers an overlay only after wide navigation yields its dock", () => {
    const input = {
      chromeEnabled: true,
      isCompactLayout: false,
      isFocusModeEnabled: false,
    };
    expect(resolveLeftSidebarPresentation({ ...input, desktopSidebarVisible: true })).toBe("dock");
    expect(resolveLeftSidebarPresentation({ ...input, desktopSidebarVisible: false })).toBe(
      "overlay",
    );
  });

  it("does not reveal navigation over a focused workspace or suppressed chrome", () => {
    const input = {
      chromeEnabled: true,
      isCompactLayout: false,
      isFocusModeEnabled: false,
      desktopSidebarVisible: false,
    };
    expect(resolveLeftSidebarPresentation({ ...input, isFocusModeEnabled: true })).toBe("hidden");
    expect(resolveLeftSidebarPresentation({ ...input, chromeEnabled: false })).toBe("hidden");
  });

  it("keeps phone navigation available independently of saved wide focus mode", () => {
    expect(
      resolveLeftSidebarPresentation({
        chromeEnabled: true,
        isCompactLayout: true,
        isFocusModeEnabled: true,
        desktopSidebarVisible: false,
      }),
    ).toBe("overlay");
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("yields app navigation when settings needs the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({ isSettingsRoute: true });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
  });

  it("imposes no content minimum outside settings", () => {
    expect(resolveDesktopAppContentMinimum({ isSettingsRoute: false })).toBe(0);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({ isSettingsRoute: false }),
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(true);
  });
});

it.each([
  [867, 200, 320, false],
  [1200, 320, 480, true],
  [1200, 320, 600, false],
  [1200, 200, 1000, false],
])(
  "preserves Explorer width with viewport %s, navigation %s, Explorer %s",
  (viewportWidth, requestedSidebarWidth, requestedExplorerWidth, expectedShares) => {
    const contentMinimumWidth = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      explorer: { requestedWidth: requestedExplorerWidth, containerWidth: viewportWidth },
    });
    const shares = canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth,
      viewportWidth,
    });
    expect(shares).toBe(expectedShares);
    const workspaceWidth = shares
      ? viewportWidth -
        resolveDesktopSidebarWidth({ requestedWidth: requestedSidebarWidth, viewportWidth })
      : viewportWidth;
    expect(
      resolveExplorerSidebarWidth({
        requestedWidth: requestedExplorerWidth,
        containerWidth: workspaceWidth,
      }),
    ).toBe(
      resolveExplorerSidebarWidth({
        requestedWidth: requestedExplorerWidth,
        containerWidth: viewportWidth,
      }),
    );
  },
);

it("insets an overlay sidebar's content by the left safe area and leaves the dock to app chrome", () => {
  expect(resolveDesktopSidebarInsetLeft({ overlay: true, safeAreaLeft: 20 })).toBe(20);
  expect(resolveDesktopSidebarInsetLeft({ overlay: false, safeAreaLeft: 20 })).toBe(0);
});
