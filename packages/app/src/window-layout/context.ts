import { createContext, useContext } from "react";
import type { EdgeInsets } from "react-native-safe-area-context";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import { resolveWorkspaceTopChromeInsets, type WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);
// Physical shell edges, independent of desktop window-control ownership.
export const WindowLayoutContentEdgesContext = createContext({ left: true, right: true });
export const WindowLayoutStatusBarHiddenContext = createContext(false);

export function useWindowLayoutStatusBarHidden(): boolean {
  return useContext(WindowLayoutStatusBarHiddenContext);
}

// Capability and edge clearances remain valid while a native geometry event catches up to JS.
// Absolute-position consumers must still use the dimension-checked useWindowLayout below.
export function useWindowLayoutHasTopChrome(): boolean {
  return useContext(WindowLayoutContext)?.topChrome != null;
}

export function useWindowLayoutTopChromeInsets(
  insets: EdgeInsets,
  edges: { left: boolean; right: boolean },
) {
  return resolveWorkspaceTopChromeInsets(useContext(WindowLayoutContext), insets, edges);
}

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useAppWindowSize();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}
