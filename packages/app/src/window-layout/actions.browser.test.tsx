import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { afterEach, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { page } from "vitest/browser";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import type { WindowLayout } from "./model";
import { WindowLayoutContext } from "./context";
import { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
import { WindowLayoutDivisionGap, WindowLayoutSurface } from "./surface";
import { lightTheme } from "@/styles/theme";
import { SidebarMenuToggle, WindowBarNavigation } from "@/components/headers/sidebar-menu-toggle";
import { usePanelStore } from "@/stores/panel-store";
import { i18n } from "@/i18n/i18next";

vi.stubGlobal("React", React);
const layout = { sidebarWidth: 465, gap: 21, contentWidth: 381 };
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};
const fullDisplayGeometry = { ...geometry, fillsDisplay: true };
const splitDisplayGeometry = { ...geometry, fillsDisplay: false };
const compactSurfaceStyle = { width: 300, height: 200 };
const headerInsets = { top: 9, right: 13, bottom: 26, left: 84 };
const barFixtures = (["leading", "trailing"] as const).map((edge) => {
  const bar = { x: edge === "leading" ? 17 : 211, y: 91, width: 44, height: 400 };
  const insets = {
    top: 9,
    right: edge === "trailing" ? 84 : 13,
    bottom: 26,
    left: edge === "leading" ? 84 : 13,
  };
  return {
    edge,
    bar,
    insets,
    barGeometry: { ...geometry, verticalBarEdge: edge, verticalBar: bar },
  };
});
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
});

it("paints the reserved division with the sidebar surface", () => {
  act(() =>
    root.render(<WindowLayoutDivisionGap layout={layout} sidebarVisible compact={false} />),
  );
  const gap = container.firstElementChild as HTMLElement;
  const expected = document.createElement("div");
  expected.style.backgroundColor = lightTheme.colors.surfaceSidebar;
  expect(getComputedStyle(gap).backgroundColor).toBe(expected.style.backgroundColor);
  expect(getComputedStyle(gap).borderRightWidth).toBe("1px");
  expect(gap.getBoundingClientRect().width).toBe(21);
});

const explorerState = { expanded: false };
const noKeys: [] = [];
const noop = () => {};

it("preserves circular explorer chrome and closes a portaled menu when actions become inactive", async () => {
  async function renderActions(active: boolean) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={geometry}>
            <WindowLayoutActionsHost />
            <WindowLayoutActions active={active}>
              <HeaderToggleButton
                onPress={noop}
                accessibilityRole="button"
                accessibilityLabel="Explorer"
                tooltipLabel="Explorer"
                tooltipSide="left"
                tooltipKeys={noKeys}
                accessibilityState={explorerState}
              >
                <Text>Explorer</Text>
              </HeaderToggleButton>
              <DropdownMenu>
                <DropdownMenuTrigger accessibilityRole="button" accessibilityLabel="Bar menu">
                  <Text>Menu</Text>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={noop}>Bar menu item</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </WindowLayoutActions>
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  await renderActions(true);
  const explorer = container.querySelector('[aria-label="Explorer"]') as HTMLElement;
  expect(getComputedStyle(explorer).borderRadius).toBe(`${lightTheme.borderRadius.full}px`);
  await page.getByRole("button", { name: "Bar menu", exact: true }).click();
  await expect.element(page.getByRole("menuitem", { name: "Bar menu item" })).toBeVisible();
  await renderActions(false);
  await expect.poll(() => document.querySelectorAll('[role="menuitem"]').length).toBe(0);
  expect(
    container.querySelector('[data-testid="workspace-vertical-actions"]')?.getBoundingClientRect()
      .height,
  ).toBe(0);
});

function SurfaceInsetsProbe() {
  const insets = useSafeAreaInsets();
  return <Text testID="surface-insets">{JSON.stringify(insets)}</Text>;
}

it.each(barFixtures)(
  "keeps the $edge bar in native window coordinates while consuming compact safe areas once",
  async ({ bar, insets, barGeometry }) => {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={barGeometry}>
            <WindowLayoutActionsHost />
            <WindowLayoutActions slot="navigation" active>
              <Text>Shell navigation</Text>
            </WindowLayoutActions>
            <SafeAreaInsetsContext.Provider value={insets}>
              <WindowLayoutSurface compact style={compactSurfaceStyle}>
                <SurfaceInsetsProbe />
                <WindowLayoutActions active>
                  <Text>Native bar action</Text>
                </WindowLayoutActions>
              </WindowLayoutSurface>
            </SafeAreaInsetsContext.Provider>
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
    const probe = container.querySelector('[data-testid="surface-insets"]') as HTMLElement;
    const surface = probe.parentElement as HTMLElement;
    expect(getComputedStyle(surface).paddingLeft).toBe(`${insets.left}px`);
    expect(getComputedStyle(surface).paddingRight).toBe(`${insets.right}px`);
    expect(probe.textContent).toBe(JSON.stringify({ ...insets, left: 0, right: 0 }));

    const actions = container.querySelector('[data-testid="window-layout-bar"]') as HTMLElement;
    expect(surface.contains(actions)).toBe(false);
    const actionStyle = getComputedStyle(actions);
    expect(actionStyle.position).toBe("absolute");
    expect(actionStyle.left).toBe(`${bar.x}px`);
    expect(actionStyle.top).toBe(`${bar.y}px`);
    expect(actionStyle.width).toBe(`${bar.width}px`);
    expect(actionStyle.height).toBe(`${bar.height}px`);
    const navigation = Array.from(actions.querySelectorAll<HTMLElement>("div")).find(
      (element) => element.textContent === "Shell navigation" && element.childElementCount === 0,
    );
    const content = Array.from(actions.querySelectorAll<HTMLElement>("div")).find(
      (element) => element.textContent === "Native bar action" && element.childElementCount === 0,
    );
    if (!navigation || !content) throw new Error("Expected shell and page bar controls");
    expect(content.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      navigation.getBoundingClientRect().bottom + 8,
    );
  },
);

it.each([
  null,
  { ...geometry, verticalBarEdge: "none" as const },
  { ...geometry, verticalBarEdge: "leading" as const, verticalBar: null },
  { ...geometry, verticalBarEdge: "trailing" as const, verticalBar: null },
])(
  "keeps compact inset ownership with the header without a resolved bar (%s)",
  async (windowLayout) => {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={windowLayout}>
            <WindowLayoutActionsHost />
            <SafeAreaInsetsContext.Provider value={headerInsets}>
              <WindowLayoutSurface compact style={compactSurfaceStyle}>
                <SurfaceInsetsProbe />
                <WindowLayoutActions active>
                  <Text>Native bar action</Text>
                </WindowLayoutActions>
              </WindowLayoutSurface>
            </SafeAreaInsetsContext.Provider>
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
    const probe = container.querySelector('[data-testid="surface-insets"]') as HTMLElement;
    const surface = probe.parentElement as HTMLElement;
    expect(getComputedStyle(surface).paddingLeft).toBe("0px");
    expect(getComputedStyle(surface).paddingRight).toBe("0px");
    expect(probe.textContent).toBe(JSON.stringify(headerInsets));
    expect(container.querySelector('[data-testid="workspace-vertical-actions"]')).toBeNull();
  },
);

it("replaces the top navigation control before sidebar animation settlement", async () => {
  const previousPanels = usePanelStore.getState();
  usePanelStore.getState().applyPanelLayout({
    isCompact: false,
    leftSidebar: "overlay",
    canDockAgentList: false,
  });
  usePanelStore.getState().showMobileAgent();
  try {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={geometry}>
            <WindowLayoutActionsHost />
            <WindowBarNavigation enabled />
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
    const bar = container.querySelector<HTMLElement>('[data-testid="window-layout-bar"]')!;
    const visibleButtons = () =>
      Array.from(bar.querySelectorAll<HTMLElement>('[role="button"]')).filter(
        (button) => button.getBoundingClientRect().height > 0,
      );
    const initial = visibleButtons();
    expect(initial).toHaveLength(1);
    const top = initial[0]!.getBoundingClientRect().top;
    // No animation provider is mounted: only the requested target changes.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await act(async () => usePanelStore.getState().showMobileAgentList());
      const open = visibleButtons();
      expect(open).toHaveLength(1);
      expect(open[0]!.getAttribute("aria-label")).toBe(i18n.t("sidebar.actions.closeSidebar"));
      expect(open[0]!.getBoundingClientRect().top).toBe(top);
      await act(async () => usePanelStore.getState().showMobileAgent());
      const closing = visibleButtons();
      expect(closing).toHaveLength(1);
      expect(closing[0]!.getAttribute("aria-label")).toBe(i18n.t("shell.menu.open"));
      expect(closing[0]!.getBoundingClientRect().top).toBe(top);
    }
  } finally {
    act(() => root.render(null));
    usePanelStore.setState(previousPanels, true);
  }
});

it("moves left navigation between the leading header and a split window's bar without duplicates", async () => {
  const previousPanels = usePanelStore.getState();
  usePanelStore.getState().showMobileAgent();
  async function renderPlacement(windowLayout: WindowLayout) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={windowLayout}>
            <SidebarMenuToggle />
            <WindowLayoutActionsHost />
            <WindowBarNavigation enabled />
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  try {
    for (const windowLayout of [fullDisplayGeometry, splitDisplayGeometry, fullDisplayGeometry]) {
      await renderPlacement(windowLayout);
      const buttons = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).filter(
        (button) => button.getBoundingClientRect().height > 0,
      );
      expect(buttons).toHaveLength(1);
      const bar = container.querySelector('[data-testid="window-layout-bar"]');
      expect(bar?.contains(buttons[0]!)).toBe(!windowLayout.fillsDisplay);
    }
  } finally {
    act(() => root.render(null));
    usePanelStore.setState(previousPanels, true);
  }
});
