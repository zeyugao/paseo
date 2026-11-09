import { buildDesktopFrameStyle } from "@/components/ui/combobox-frame-style";
import {
  WorkspaceHeaderExplorerToggle,
  WorkspaceExplorerSidebarToggle,
} from "./workspace-explorer-toggle";
import { describe, expect, it } from "vitest";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import { resolveWorkspaceTabChipBackdrop } from "@/screens/workspace/workspace-tab-chip-backdrop";
import { darkPureBlackTheme, darkTheme, lightTheme } from "@/styles/theme";
import {
  workspaceTabSwitcherPopoverLayout,
  selectWorkspaceChrome,
  computeWorkspaceTabLayout,
  retainWorkspaceTabMeasuredWidth,
  shouldUseInlineWorkspaceHeader,
  WORKSPACE_INLINE_TABS_MIN_WIDTH,
  resolveInlineWorkspaceTabPresentation,
  resolveInlineWorkspaceTabBudget,
  workspaceTabNaturalWidth,
} from "@/screens/workspace/workspace-tab-layout";
import { resolveWorkspaceTopChromeInsets, type WindowLayout } from "@/window-layout/model";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";

describe("workspace top chrome placement", () => {
  const layout: WindowLayout = {
    bounds: { x: 0, y: 0, width: 669, height: 951 },
    verticalBarEdge: "none",
    verticalBar: null,
    divisions: [],
    topChrome: { x: 6, y: 0, width: 519, height: 44 },
  };
  const insets = { top: 84, left: 0, right: 0 };
  const edges = { left: true, right: true };

  it("moves both rows together without preserving the empty top inset", () => {
    expect(resolveWorkspaceTopChromeInsets(layout, insets, edges)).toEqual({
      paddingTop: 0,
      paddingLeft: 6,
      paddingRight: 144,
    });
  });

  it("applies corner clearance only to the column occupying that window edge", () => {
    expect(resolveWorkspaceTopChromeInsets(layout, insets, { left: false, right: true })).toEqual({
      paddingTop: 0,
      paddingLeft: 0,
      paddingRight: 144,
    });
    expect(resolveWorkspaceTopChromeInsets(layout, insets, { left: true, right: false })).toEqual({
      paddingTop: 0,
      paddingLeft: 6,
      paddingRight: 0,
    });
    expect(resolveWorkspaceTopChromeInsets(layout, insets, { left: false, right: false })).toEqual({
      paddingTop: 0,
      paddingLeft: 0,
      paddingRight: 0,
    });
  });

  it("credits horizontal clearance already consumed by the native shell", () => {
    expect(resolveWorkspaceTopChromeInsets(layout, { top: 84, left: 4, right: 84 }, edges)).toEqual(
      {
        paddingTop: 0,
        paddingLeft: 2,
        paddingRight: 60,
      },
    );
  });

  it("keeps normal safe areas when the native top row is unavailable", () => {
    expect(resolveWorkspaceTopChromeInsets(null, insets, edges)).toBeNull();
    expect(
      resolveWorkspaceTopChromeInsets({ ...layout, topChrome: null }, insets, edges),
    ).toBeNull();
  });

  it("reserves system controls before the status-bar inset returns", () => {
    expect(resolveWorkspaceTopChromeInsets(layout, { ...insets, top: 0 }, edges)).toEqual({
      paddingTop: 0,
      paddingLeft: 6,
      paddingRight: 144,
    });
  });
});

describe("inline workspace header availability", () => {
  const landscape: WindowLayout = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    verticalBarEdge: "trailing",
    verticalBar: { x: 867, y: 0, width: 84, height: 669 },
    divisions: [],
  };

  it("merges the header only beside a usable trailing bar in a landscape window", () => {
    expect(shouldUseInlineWorkspaceHeader(landscape)).toBe(true);
    expect(shouldUseInlineWorkspaceHeader(null)).toBe(false);
    expect(shouldUseInlineWorkspaceHeader({ ...landscape, verticalBar: null })).toBe(false);
    expect(shouldUseInlineWorkspaceHeader({ ...landscape, verticalBarEdge: "leading" })).toBe(
      false,
    );
    expect(
      shouldUseInlineWorkspaceHeader({
        ...landscape,
        bounds: { x: 0, y: 0, width: 669, height: 951 },
      }),
    ).toBe(false);
    expect(
      shouldUseInlineWorkspaceHeader({
        ...landscape,
        bounds: { x: 0, y: 0, width: 669, height: 669 },
      }),
    ).toBe(false);
  });

  it("keeps compact and focus-mode headers independent of the landscape bar", () => {
    expect(shouldUseInlineWorkspaceHeader(landscape, true, false)).toBe(false);
    expect(shouldUseInlineWorkspaceHeader(landscape, false, true)).toBe(false);
    expect(shouldUseInlineWorkspaceHeader(landscape, false, false)).toBe(true);
  });
});

describe("inline workspace tab presentation", () => {
  function requiredWidth(labels: number[], addButtonWidth = 40) {
    const inlineMetrics = {
      ...metrics,
      actionsReservedWidth: addButtonWidth,
      rowPaddingHorizontal: 4,
      rowHorizontalInset: labels.length > 0 ? metrics.tabGap / 2 : 0,
    };
    const layout = computeWorkspaceTabLayout({
      viewportWidth: 1000,
      tabLabelWidths: labels,
      metrics: inlineMetrics,
      compact: false,
      preserveNaturalWidths: true,
    });
    return workspaceTabNaturalWidth(layout, inlineMetrics);
  }

  it("keeps a single tab and its add button at the exact narrow fit boundary", () => {
    const required = requiredWidth([105]);
    expect(required).toBeLessThan(WORKSPACE_INLINE_TABS_MIN_WIDTH);
    expect(resolveInlineWorkspaceTabPresentation(required - 1, required)).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(required, required)).toBe("tabs");
  });

  it("does not mistake enough room for the tab alone for room for its add button", () => {
    const required = requiredWidth([105]);
    expect(resolveInlineWorkspaceTabPresentation(required - 40, required)).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(required, requiredWidth([105], 44))).toBe(
      "switcher",
    );
  });

  it("fits multiple short tabs without treating their count as a collapse rule", () => {
    const required = requiredWidth([29, 52]);
    expect(resolveInlineWorkspaceTabPresentation(required, required)).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(required - 1, required)).toBe("switcher");
  });

  it("restores a narrow rail when closing a tab makes the complete track fit", () => {
    const available = requiredWidth([105]);
    const picker = resolveInlineWorkspaceTabPresentation(available, requiredWidth([105, 105]));
    expect(picker).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(available, requiredWidth([105]), picker)).toBe(
      "tabs",
    );
  });

  it("keeps a wide overflowing track as a scrolling rail", () => {
    expect(
      resolveInlineWorkspaceTabPresentation(
        WORKSPACE_INLINE_TABS_MIN_WIDTH,
        requiredWidth([160, 160, 160]),
      ),
    ).toBe("tabs");
  });

  it("includes both outboard slot margins before choosing overflow", () => {
    const inlineMetrics = {
      ...metrics,
      actionsReservedWidth: 44,
      rowPaddingHorizontal: 4,
      rowHorizontalInset: 2,
    };
    const atWidth = (viewportWidth: number) =>
      computeWorkspaceTabLayout({
        viewportWidth,
        tabLabelWidths: [126, 126],
        metrics: inlineMetrics,
        compact: false,
        preserveNaturalWidths: true,
      });
    // Two 160-point chips, two 4-point slots, 8-point padding, and the 44-point add button.
    expect(workspaceTabNaturalWidth(atWidth(380), inlineMetrics)).toBe(380);
    expect(atWidth(380).requiresHorizontalScrollFallback).toBe(false);
    expect(atWidth(379).requiresHorizontalScrollFallback).toBe(true);
    expect(atWidth(376).requiresHorizontalScrollFallback).toBe(true);
  });

  it("reserves the complete slot margins at a narrow multi-tab fit boundary", () => {
    const required = requiredWidth([29, 52], 44);
    expect(required).toBe(210);
    expect(resolveInlineWorkspaceTabPresentation(209, required)).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(210, required)).toBe("tabs");
  });

  it("retains its presentation until a changed track has complete measurements", () => {
    expect(resolveInlineWorkspaceTabPresentation(180, null, "tabs")).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(180, null, "switcher")).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(240, 230, "switcher")).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(200, 230, "tabs")).toBe("switcher");
  });

  it("switches from the target main width when Explorer opens, not the previous wide frame", () => {
    const workspaceWidth = 867;
    const explorerWidth = resolveExplorerSidebarWidth({
      requestedWidth: 440,
      containerWidth: workspaceWidth,
    });
    const chrome = { horizontalInset: 24, leadingWidth: 150, gap: 16 };
    const trackWidth = requiredWidth([105, 105]);
    const openBudget = resolveInlineWorkspaceTabBudget({
      ...chrome,
      width: workspaceWidth - explorerWidth,
    });
    const closedBudget = resolveInlineWorkspaceTabBudget({ ...chrome, width: workspaceWidth });
    expect(resolveInlineWorkspaceTabPresentation(closedBudget, trackWidth)).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(openBudget, trackWidth, "tabs")).toBe("switcher");
    expect(resolveInlineWorkspaceTabPresentation(closedBudget, trackWidth, "switcher")).toBe(
      "tabs",
    );
  });

  it("reserves header chrome and the title gap at the exact fit boundary", () => {
    const geometry = { width: 400, horizontalInset: 24, leadingWidth: 120, gap: 16 };
    const budget = resolveInlineWorkspaceTabBudget(geometry);
    expect(budget).toBe(240);
    expect(resolveInlineWorkspaceTabPresentation(budget, 240)).toBe("tabs");
    const obstructed = resolveInlineWorkspaceTabBudget({ ...geometry, horizontalInset: 25 });
    expect(resolveInlineWorkspaceTabPresentation(obstructed, 240)).toBe("switcher");
  });

  it("does not let a long measured title consume the entire collapse budget", () => {
    const budget = resolveInlineWorkspaceTabBudget({
      width: 420,
      horizontalInset: 24,
      leadingWidth: 900,
      gap: 16,
    });
    expect(budget).toBe(248);
    expect(resolveInlineWorkspaceTabPresentation(budget, 248)).toBe("tabs");
    expect(resolveInlineWorkspaceTabPresentation(budget, 249)).toBe("switcher");
  });

  it("does not allocate a negative rail when window chrome consumes the header", () => {
    const budget = resolveInlineWorkspaceTabBudget({
      width: 20,
      horizontalInset: 24,
      leadingWidth: 150,
      gap: 16,
    });
    expect(budget).toBe(0);
    expect(resolveInlineWorkspaceTabPresentation(budget, 40)).toBe("switcher");
  });
});

const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  minTabWidth: 64,
  maxTabWidth: 160,
  tabIconWidth: 14,
  tabContentGap: 4,
  tabHorizontalPadding: 8,
  closeButtonWidth: 0,
};

describe("computeWorkspaceTabLayout", () => {
  it("keeps each tab at its natural content width when space is available", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("lets short labels use their content width below the old 96px floor", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 300,
      tabLabelWidths: [29, 52],
      metrics: { ...metrics, actionsReservedWidth: 36 },
      compact: false,
    });
    expect(result.items).toEqual([
      { width: 64, showLabel: true },
      { width: 86, showLabel: true },
    ]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("sizes a single tab between the minimum and maximum from its content", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [105],
      metrics,
      compact: false,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([139]);
  });

  it("shrinks natural widths proportionally without crossing the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([132, 102, 82]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("caps long tabs at the maximum width", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1004,
      tabLabelWidths: [280, 280, 280, 280],
      metrics: {
        ...metrics,
        actionsReservedWidth: 44,
        rowPaddingHorizontal: 0,
        tabGap: 0,
      },
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([160, 160, 160, 160]);
  });

  it("keeps every tab at the clickable minimum at the exact fit boundary", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 404,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("scrolls at natural widths rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 403,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([132, 132, 132, 132]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps natural widths and no inline close on compact layouts while the tabs fit", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 600,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: true,
    });

    expect(result.closeButtonPolicy).toBe("none");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("scrolls compact layouts as soon as natural widths overflow instead of squeezing labels", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: true,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps overflowing embedded tabs visible at natural widths without removing close controls", () => {
    const viewportWidth = 460;
    expect(resolveInlineWorkspaceTabPresentation(viewportWidth, null)).toBe("tabs");
    const result = computeWorkspaceTabLayout({
      viewportWidth,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
      preserveNaturalWidths: true,
    });
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.closeButtonPolicy).toBe("all");
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("uses rendered label width rather than character count", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [68, 104],
      metrics,
      compact: false,
    });

    expect(result.items.map((item) => item.width)).toEqual([102, 138]);
  });
});

describe("retainWorkspaceTabMeasuredWidth", () => {
  it("retains the last usable width while a retained panel is hidden", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 0)).toBe(720);
  });

  it("accepts the next usable layout width", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 640)).toBe(640);
  });
});

describe("Explorer toggle ownership", () => {
  const toggleProps = {
    onPress: () => {},
    label: "Close Explorer sidebar",
    tooltipLabel: "Toggle Explorer sidebar",
    tooltipKeys: [],
    accessibilityState: { expanded: true },
  };

  it("keeps only the header toggle when window controls do not obstruct it", () => {
    expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner: "header" })).not.toBeNull();
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "header" })).toBeNull();
  });

  it("keeps the dock toggle for window-owned and compact overlay chrome", () => {
    for (const owner of ["window", "mobile"] as const) {
      expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner })).toBeNull();
      expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner })).not.toBeNull();
    }
  });

  it("closes the compact overlay with the same X as the compact agent list", () => {
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "mobile" })?.type).toBe(
      SidebarCloseButton,
    );
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "window" })?.type).not.toBe(
      SidebarCloseButton,
    );
  });
});

describe("resolveWorkspaceTabChipBackdrop", () => {
  const themes = { light: lightTheme, dark: darkTheme, pureBlack: darkPureBlackTheme };
  const rails = {
    sidebar: "surfaceSidebar",
    surface: "surface0",
  } as const;

  it("paints the active chip in a colour the rail does not already use, in every theme", () => {
    for (const [, theme] of Object.entries(themes)) {
      for (const [rail, resting] of Object.entries(rails) as Array<
        [keyof typeof rails, (typeof rails)[keyof typeof rails]]
      >) {
        const active = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: true,
          isFilled: true,
        });
        const filled = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: false,
          isFilled: true,
        });
        expect(theme.colors[active]).not.toBe(theme.colors[resting]);
        expect(theme.colors[filled]).not.toBe(theme.colors[resting]);
        expect(theme.colors[active]).not.toBe(theme.colors[filled]);
      }
    }
  });

  it("rests on the rail surface when the chip is neither active nor hovered", () => {
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "sidebar", isActiveFocused: false, isFilled: false }),
    ).toBe("surfaceSidebar");
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "surface", isActiveFocused: false, isFilled: false }),
    ).toBe("surface0");
  });
});

import { shouldUseCompactWorkspaceHeader } from "./workspace-tab-layout";
it.each([
  [349, true],
  [519, true],
  [549, true],
  [550, false],
  [800, false],
])("workspace width %s selects compact=%s", (width, compact) => {
  expect(shouldUseCompactWorkspaceHeader(width)).toBe(compact);
});

describe("desktop pane chrome", () => {
  it("replaces the pane header and rail together at the pane width boundary", () => {
    const full = ["workspace header", "pane tab rail"];
    expect(selectWorkspaceChrome({ width: 440, compact: "pane dropdown", full })).toBe(
      "pane dropdown",
    );
    expect(selectWorkspaceChrome({ width: 550, compact: "pane dropdown", full })).toBe(full);
    expect(selectWorkspaceChrome({ width: null, compact: "pane dropdown", full })).toBe(full);
  });
});

it("gives the tab switcher a readable popover width independent of its 16pt count badge", () => {
  const frame = buildDesktopFrameStyle({
    desktopMinWidth: workspaceTabSwitcherPopoverLayout.desktopMinWidth,
    desktopLockWidth: false,
    referenceWidth: 16,
    desktopFixedHeight: undefined,
    desktopPositionStyle: {},
    shouldHideDesktopContent: false,
    availableHeight: 600,
  }) as Array<{ minWidth?: number }>;
  expect(frame[0].minWidth).toBeGreaterThanOrEqual(320);
});
