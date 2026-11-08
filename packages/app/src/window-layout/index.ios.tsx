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
import {
  WindowLayoutContext,
  WindowLayoutStatusBarHiddenContext,
  useWindowLayout,
} from "./context";
import { resolveSafeAreaInsets, type WindowLayout } from "./model";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import invariant from "tiny-invariant";

export {
  useWindowLayout,
  useWindowLayoutHasTopChrome,
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
            <WindowSafeAreaInsets>{children}</WindowSafeAreaInsets>
          </View>
        </WindowLayoutStatusBarHiddenContext.Provider>
      </WindowLayoutContext.Provider>
    </StatusBarPreferenceContext.Provider>
  );
}

/** The one bottom inset every descendant reads through `useSafeAreaInsets()`. */
function WindowSafeAreaInsets({ children }: { children: ReactNode }) {
  const systemInsets = useSafeAreaInsets();
  const layout = useWindowLayout();
  const insets = useMemo(() => resolveSafeAreaInsets(systemInsets, layout), [systemInsets, layout]);
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
