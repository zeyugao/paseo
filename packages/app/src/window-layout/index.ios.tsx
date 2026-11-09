import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { WindowLayoutContext, WindowLayoutStatusBarHiddenContext } from "./context";
import { resolveSafeAreaInsets, type WindowLayout } from "./model";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import invariant from "tiny-invariant";
import { AppWindowFrameContext } from "@/hooks/app-window-frame-context";

export {
  useWindowLayout,
  useWindowLayoutHasTopChrome,
  useWindowLayoutHasTopEdgeControls,
  useWindowLayoutStatusBarHidden,
} from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, WindowLayout, WindowLayoutRect } from "./model";

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
>("PaseoWindowLayout");

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [geometry, setGeometry] = useState<WindowLayout | null>(null);
  const [statusBarHidden, setStatusBarHidden] = useState(false);
  const onGeometryChange = useCallback(
    (event: NativeSyntheticEvent<WindowLayout>) => setGeometry(event.nativeEvent),
    [],
  );
  return (
    <StatusBarPreferenceContext.Provider value={setStatusBarHidden}>
      <AppWindowFrameContext.Provider value={geometry?.bounds ?? null}>
        <WindowLayoutContext.Provider value={geometry}>
          <WindowLayoutStatusBarHiddenContext.Provider value={statusBarHidden}>
            <View style={styles.root}>
              <GeometryProbe
                pointerEvents="none"
                style={StyleSheet.absoluteFill}
                topChromeRowHeight={HEADER_INNER_HEIGHT}
                statusBarHidden={statusBarHidden}
                onGeometryChange={onGeometryChange}
              />
              <WindowSafeAreaInsets geometry={geometry}>{children}</WindowSafeAreaInsets>
            </View>
          </WindowLayoutStatusBarHiddenContext.Provider>
        </WindowLayoutContext.Provider>
      </AppWindowFrameContext.Provider>
    </StatusBarPreferenceContext.Provider>
  );
}

/** Descendants read the same scene snapshot used to allocate their columns. */
function WindowSafeAreaInsets({
  children,
  geometry,
}: {
  children: ReactNode;
  geometry: WindowLayout | null;
}) {
  const systemInsets = useSafeAreaInsets();
  const sourceInsets = geometry?.insets ?? systemInsets;
  const insets = useMemo(
    () => resolveSafeAreaInsets(sourceInsets, geometry),
    [sourceInsets, geometry],
  );
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
