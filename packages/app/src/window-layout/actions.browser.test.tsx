import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { afterEach, expect, it, vi } from "vitest";
import { Text, View } from "react-native";
import { page } from "vitest/browser";
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
import { WindowLayoutDivisionGap } from "./surface";
import { lightTheme } from "@/styles/theme";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { MenuHeader } from "@/components/headers/menu-header";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { ToastProvider } from "@/contexts/toast-context";
import { CompactWorkspaceHeader } from "@/screens/workspace/compact-workspace-header";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { SidebarResizeGeometryProvider } from "./sidebar-resize-geometry";
const headerInsets = { top: 84, left: 0, right: 0, bottom: 0 };
const headerAction = <Text testID="header-action">Action</Text>;

it("reclaims the page header top band and restores safe-area clearance when it disappears", async () => {
  const topBand: WindowLayout = {
    ...geometry,
    verticalBarEdge: "none",
    verticalBar: null,
    topChrome: { x: 6, y: 0, width: window.innerWidth - 150, height: 44 },
  };
  async function renderHeader(layout: WindowLayout | null) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <SafeAreaInsetsContext.Provider value={headerInsets}>
            <WindowLayoutContext.Provider value={layout}>
              <MenuHeader title="History" rightContent={headerAction} />
            </WindowLayoutContext.Provider>
          </SafeAreaInsetsContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  const header = () =>
    container.querySelector('[data-testid="composer-dock-header"]') as HTMLElement;
  await renderHeader(null);
  const normalHeight = header().getBoundingClientRect().height;
  await renderHeader(topBand);
  expect(header().getBoundingClientRect().height).toBe(normalHeight - headerInsets.top);
  const action = container.querySelector('[data-testid="header-action"]') as HTMLElement;
  expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(
    container.getBoundingClientRect().left + window.innerWidth - 144,
  );
  await renderHeader({
    ...topBand,
    bounds: { ...topBand.bounds, width: window.innerWidth - 100 },
    topChrome: { x: 6, y: 0, width: window.innerWidth - 250, height: 44 },
  });
  expect(header().getBoundingClientRect().height).toBe(normalHeight - headerInsets.top);
  expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(
    container.getBoundingClientRect().left + window.innerWidth - 144,
  );
  await renderHeader({ ...topBand, topChrome: null });
  expect(header().getBoundingClientRect().height).toBe(normalHeight);
});

vi.stubGlobal("React", React);
const layout = { sidebarWidth: 465, gap: 21, contentWidth: 381 };
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};
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
const tabSwitcher = <Text>Tabs</Text>;
const headerGeometry = {
  workspaceKey: null,
  containerWidth: window.innerWidth - 84,
  explorer: null,
};
const gitBarInsets = { ...headerInsets, right: 84 };
const gitContentStyle = { width: window.innerWidth - 84 };
const gitBarGeometry: WindowLayout = {
  ...geometry,
  verticalBar: { x: window.innerWidth - 84, y: 0, width: 84, height: window.innerHeight },
};

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

it("keeps Git actions reachable across compact and inline header placement", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const serverId = "header-git-host";
  const cwd = "/header-git-repo";
  client.setQueryData(checkoutStatusQueryKey(serverId, cwd), {
    cwd,
    requestId: "header-git-status",
    error: null,
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: cwd,
    currentBranch: "feature",
    baseRef: "origin/main",
    isDirty: true,
    isPaseoOwnedWorktree: false,
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "git@github.com:example/repo.git",
  } satisfies CheckoutStatusPayload);

  const workspaceMenu = <Text>Workspace menu</Text>;

  async function renderHeader(
    headerVariant: "compact" | "inline",
    windowGeometry: WindowLayout | null,
  ) {
    const header = (
      <SidebarResizeGeometryProvider viewportWidth={window.innerWidth}>
        <CompactWorkspaceHeader
          serverId={serverId}
          workspaceDirectory={cwd}
          isLoading={false}
          title="Workspace"
          subtitle="Project"
          isSubtitleDistinct={false}
          onToggleExplorer={noop}
          explorerToggleLabel="Explorer"
          explorerToggleAccessibilityState={explorerState}
          tabSwitcher={tabSwitcher}
          inlineHeaderGeometry={headerGeometry}
          headerVariant={headerVariant}
          actionsActive
        >
          {workspaceMenu}
        </CompactWorkspaceHeader>
      </SidebarResizeGeometryProvider>
    );
    const content = <View style={windowGeometry ? gitContentStyle : undefined}>{header}</View>;
    await act(async () =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <ToastProvider>
              <PortalProvider>
                <SafeAreaInsetsContext.Provider
                  value={windowGeometry ? gitBarInsets : headerInsets}
                >
                  <WindowLayoutContext.Provider value={windowGeometry}>
                    <WindowLayoutActionsHost />
                    {content}
                  </WindowLayoutContext.Provider>
                </SafeAreaInsetsContext.Provider>
              </PortalProvider>
            </ToastProvider>
          </QueryClientProvider>
        </I18nextProvider>,
      ),
    );
  }

  try {
    for (const [variant, windowGeometry] of [
      ["compact", gitBarGeometry],
      ["compact", null],
      ["inline", gitBarGeometry],
    ] as const) {
      await renderHeader(variant, windowGeometry);
      const trigger = page.getByRole("button", {
        name: i18n.t("workspace.git.actions.moreActions"),
        exact: true,
      });
      await expect.element(trigger).toBeVisible();
      await trigger.click();
      await expect
        .element(
          page.getByRole("menuitem", {
            name: i18n.t("workspace.git.actions.commit.label"),
            exact: true,
          }),
        )
        .toBeVisible();
    }
  } finally {
    act(() => root.render(null));
    client.clear();
  }
});
