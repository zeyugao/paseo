import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import { WindowInsetsContext, useWindowLayout } from "./context";

export { useWindowLayout, useWindowLayoutHasTopEdgeControls } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export { WindowLayoutTopInset } from "./top-inset";
export { WindowLayoutGeometryView, WindowLayoutGeometryText } from "./react-layout-view";
export { useTopBand } from "./context";
export { WindowSafeArea } from "./window-safe-area";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, TopBand, WindowLayout, WindowLayoutRect } from "./model";

export function useWindowLayoutViewport() {
  const geometry = useWindowLayout();
  const { width, height } = useAppWindowSize();
  const insets = useSafeAreaInsets();
  return { geometry, width, height, insets };
}

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <WindowInsetsContext.Provider value={insets}>{children}</WindowInsetsContext.Provider>;
}
