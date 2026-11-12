import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppWindowFrameContext } from "@/hooks/app-window-frame-context";
import { TopBandContext, WindowLayoutContext, WindowLayoutStatusBarHiddenContext } from "./context";
import { resolveSafeAreaInsets, resolveTopBand, type WindowLayout } from "./model";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import invariant from "tiny-invariant";

export {
  useWindowLayout,
  useWindowLayoutHasTopChrome,
  useWindowLayoutHasTopEdgeControls,
} from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export { WindowLayoutTopInset } from "./top-inset";
export { useTopBand } from "./context";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, TopBand, WindowLayout, WindowLayoutRect } from "./model";

const StatusBarPreferenceContext = createContext<((hidden: boolean) => void) | null>(null);

export function WindowLayoutStatusBar({ hidden }: { hidden: boolean }) {
  const setHidden = useContext(StatusBarPreferenceContext);
  invariant(setHidden, "WindowLayoutStatusBar requires WindowLayoutProvider");
  useLayoutEffect(() => {
    setHidden(hidden);
    return () => setHidden(false);
  }, [hidden, setHidden]);
  return null;
}

const GeometryProbe = requireNativeViewManager<
  ViewProps & {
    topChromeRowHeight: number;
    statusBarHidden: boolean;
    onGeometryChange: (event: NativeSyntheticEvent<WindowLayout>) => void;
  }
>("PaseoWindowLayout", "WindowLayoutView");

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [geometry, setGeometry] = useState<WindowLayout | null>(null);
  const [statusBarHidden, setStatusBarHidden] = useState(false);
  const onGeometryChange = useCallback(
    (event: NativeSyntheticEvent<WindowLayout>) => setGeometry(event.nativeEvent),
    [],
  );
  return (
    <StatusBarPreferenceContext.Provider value={setStatusBarHidden}>
      <WindowLayoutStatusBarHiddenContext.Provider value={statusBarHidden}>
        <AppWindowFrameContext.Provider value={geometry?.bounds ?? null}>
          <WindowLayoutContext.Provider value={geometry}>
            <GeometryProbe
              style={styles.root}
              topChromeRowHeight={HEADER_INNER_HEIGHT}
              statusBarHidden={statusBarHidden}
              onGeometryChange={onGeometryChange}
            >
              <WindowSafeAreaInsets>{children}</WindowSafeAreaInsets>
            </GeometryProbe>
          </WindowLayoutContext.Provider>
        </AppWindowFrameContext.Provider>
      </WindowLayoutStatusBarHiddenContext.Provider>
    </StatusBarPreferenceContext.Provider>
  );
}

/**
 * The one top and bottom inset every descendant reads through `useSafeAreaInsets()`, and
 * the top band that `WindowChromeProvider` reads through `useTopBand()`.
 */
function WindowSafeAreaInsets({ children }: { children: ReactNode }) {
  const systemInsets = useSafeAreaInsets();
  // Capability and insets use the same snapshot even while JS dimensions catch up to UIKit.
  const layout = useContext(WindowLayoutContext);
  const statusBarHidden = useContext(WindowLayoutStatusBarHiddenContext);
  const insets = useMemo(() => resolveSafeAreaInsets(systemInsets, layout), [systemInsets, layout]);
  const topBand = useMemo(
    () => resolveTopBand(systemInsets.top, layout, statusBarHidden),
    [systemInsets.top, layout, statusBarHidden],
  );
  return (
    <TopBandContext.Provider value={topBand}>
      <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>
    </TopBandContext.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
