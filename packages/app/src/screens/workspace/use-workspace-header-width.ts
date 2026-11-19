import { createContext, useContext } from "react";
import { Platform } from "react-native";
import { useStore } from "zustand";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { WindowLayoutContentAllocationContext, useWindowLayout } from "@/window-layout/context";
import { useSidebarResizeGeometry } from "@/window-layout/sidebar-resize-geometry";
import { resolveWorkspaceActionPlacement } from "@/window-layout/model";
import { useWindowChromeInlinePadding } from "@/utils/desktop-window";
import { shouldUseCompactWorkspaceHeader } from "./workspace-tab-layout";

export const WorkspaceHeaderWidthContext = createContext<number | null>(null);

export function useWorkspaceHeaderGitInOverflow() {
  const width = useContext(WorkspaceHeaderWidthContext);
  const layout = useWindowLayout();
  const corner = useWindowChromeInlinePadding();
  const cornerClearance = Platform.OS === "ios" ? corner.paddingLeft + corner.paddingRight : 0;
  return (
    width !== null &&
    shouldUseCompactWorkspaceHeader(width - cornerClearance) &&
    resolveWorkspaceActionPlacement(layout) !== "vertical-bar"
  );
}

export interface WorkspaceHeaderGeometry {
  workspaceKey: string | null;
  containerWidth: number;
  explorer: { requestedWidth: number | undefined; containerWidth: number } | null;
}

export function useWorkspaceContainerWidth(workspaceKey: string | null, targetWidth: number) {
  const allocation = useContext(WindowLayoutContentAllocationContext);
  const { store, viewportWidth } = useSidebarResizeGeometry();
  const leftDockWidth = allocation?.workspaceKey === workspaceKey ? allocation.leftDockWidth : 0;
  const leftWidth = useStore(store, (state) =>
    leftDockWidth > 0 && state.left?.viewportWidth === viewportWidth ? state.left.width : null,
  );
  return Math.max(0, targetWidth + (leftWidth === null ? 0 : leftDockWidth - leftWidth));
}

export function useWorkspaceHeaderWidth(geometry: WorkspaceHeaderGeometry) {
  const allocation = useContext(WindowLayoutContentAllocationContext);
  const { store, viewportWidth } = useSidebarResizeGeometry();
  const active = allocation?.workspaceKey === geometry.workspaceKey;
  const explorerWidth = useStore(store, (state) =>
    active &&
    geometry.explorer &&
    state.explorer?.viewportWidth === viewportWidth &&
    state.explorer.workspaceKey === geometry.workspaceKey &&
    state.explorer.containerWidth === geometry.explorer.containerWidth
      ? state.explorer.width
      : null,
  );
  const containerWidth = useWorkspaceContainerWidth(geometry.workspaceKey, geometry.containerWidth);
  if (!geometry.explorer) return containerWidth;
  return Math.max(
    0,
    containerWidth -
      resolveExplorerSidebarWidth({
        requestedWidth: explorerWidth ?? geometry.explorer.requestedWidth,
        containerWidth,
      }),
  );
}
