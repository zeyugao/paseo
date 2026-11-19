import { createContext, useContext } from "react";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { TopBand, WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);

/** Published by `WindowLayoutProvider` beside the safe-area insets it derives from it. */
export const TopBandContext = createContext<TopBand | null>(null);

/**
 * The insets of the whole window, published by `WindowLayoutProvider` before any surface (a
 * sheet tab, for one) narrows the insets its content reads.
 */
export const WindowInsetsContext = createContext<EdgeInsets | null>(null);

export const WindowLayoutContentAllocationContext = createContext<{
  workspaceKey: string | null;
  explorerVisible: boolean;
  hasPinnedSidebar: boolean;
  inlineHeaderActive: boolean;
  // A docked navigation sidebar owns live resize geometry through flex layout.
  width: number | null;
  targetWidth: number;
  leftDockWidth: number;
} | null>(null);

/** The allocated pane width before component-local padding; null when the pane sizes itself. */
export const WindowLayoutPaneWidthContext = createContext<number | null>(null);

export function useWindowLayout(): WindowLayout | null {
  return useContext(WindowLayoutContext);
}

/** The top band beside the system's status region, or null where the window has none. */
export function useTopBand(): TopBand | null {
  return useContext(TopBandContext);
}

/** App controls in the system's top band must not trigger UIKit's status-bar tap gesture. */
export function useWindowLayoutHasTopEdgeControls(): boolean {
  const layout = useWindowLayout();
  const topBand = useTopBand();
  return topBand !== null || layout?.verticalBar != null;
}
