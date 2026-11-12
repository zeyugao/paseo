import { describe, expect, it } from "vitest";
import {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
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
  resolveSidebarMenuTogglePresentation,
} from "@/components/desktop-sidebar-layout";
import { windowChromeCornersInclude } from "@/utils/desktop-window";

describe("desktop sidebar layout", () => {
  const geometry: WindowLayout = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
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

  it("shows the tab count only for the compact header selection", () => {
    expect(resolveWorkspaceBarActions("compact")).toEqual(["tab-count", "overflow", "explorer"]);
    expect(resolveWorkspaceBarActions("full")).toEqual(["overflow", "explorer"]);
    expect(resolveWorkspaceBarActions("inline")).toEqual(["git", "overflow", "explorer"]);
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

  it("keeps navigation togglable without moving the content allocation across a division", () => {
    const divisionLayout = { sidebarWidth: 465, gap: 21, contentWidth: 381 };
    const visibility = {
      chromeEnabled: true,
      isCompactLayout: false,
      isMounted: true,
      canShare: false,
      divisionLayout,
    };
    expect(resolveDesktopSidebarVisibility({ ...visibility, isOpen: true })).toBe(true);
    expect(resolveDesktopSidebarVisibility({ ...visibility, isOpen: false })).toBe(false);
    expect(
      resolveDesktopSidebarVisibility({ ...visibility, divisionLayout: null, isOpen: true }),
    ).toBe(false);
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
      sidebarCorners: "top-left",
      contentCorners: "top-right",
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

  it.each([
    { docked: false, windowControls: false, expected: "button" },
    { docked: true, windowControls: false, expected: "button" },
    { docked: false, windowControls: true, expected: "placeholder" },
    { docked: true, windowControls: true, expected: "hidden" },
  ] as const)(
    "keeps one visible toggle with docked=$docked and windowControls=$windowControls",
    ({ docked, windowControls, expected }) => {
      const chrome = resolveDesktopAppChromeLayout({
        desktopSidebarRendered: docked,
        hasTopLeftWindowControls: windowControls,
        sidebarControlsEnabled: true,
      });
      const presentation = resolveSidebarMenuTogglePresentation({
        isCompact: false,
        ownsTopLeft: windowChromeCornersInclude(chrome.contentCorners, "top-left"),
        hasTopLeftWindowControls: windowControls,
      });
      expect(presentation).toBe(expected);
      expect(
        Number(chrome.sidebarToggleOwner === "window") + Number(presentation === "button"),
      ).toBe(1);
    },
  );

  it("keeps compact navigation visible independently of window controls and corner ownership", () => {
    expect(
      resolveSidebarMenuTogglePresentation({
        isCompact: true,
        ownsTopLeft: false,
        hasTopLeftWindowControls: true,
      }),
    ).toBe("button");
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

it("yields navigation rather than clamping Explorer when only its minimum width fits", () => {
  const contentMinimumWidth = resolveDesktopAppContentMinimum({
    isSettingsRoute: false,
    explorerVisible: true,
    explorerSidebarWidth: 309,
  });
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 203,
      viewportWidth: 867,
    }),
  ).toBe(false);
  expect(
    canDesktopAppSidebarShare({
      contentMinimumWidth,
      requestedSidebarWidth: 203,
      viewportWidth: 872,
    }),
  ).toBe(true);
});

it("insets an overlay sidebar's content by the left safe area and leaves the dock to app chrome", () => {
  expect(resolveDesktopSidebarInsetLeft({ overlay: true, safeAreaLeft: 20 })).toBe(20);
  expect(resolveDesktopSidebarInsetLeft({ overlay: false, safeAreaLeft: 20 })).toBe(0);
});
