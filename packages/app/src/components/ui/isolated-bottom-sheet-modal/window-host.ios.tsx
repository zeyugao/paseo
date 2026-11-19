import {
  BottomSheetModalInternalProvider,
  INITIAL_CONTAINER_LAYOUT,
  useBottomSheetModalInternal,
} from "@gorhom/bottom-sheet";
import { PortalHost } from "@gorhom/portal";
import { requireNativeViewManager } from "expo-modules-core";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { AppWindowCompactContext, AppWindowFrameContext } from "@/hooks/app-window-frame-context";
import { TopBandContext, WindowLayoutContext, useWindowLayout } from "@/window-layout/context";
import { resolveWorkspaceActionPlacement } from "@/window-layout/model";
import { LAYOUT_BREAKPOINTS } from "@/constants/layout-breakpoints";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { SheetWindowContext } from "./window-host-context";

interface SheetGeometry {
  bounds: Metrics["frame"];
  insets: Metrics["insets"];
}

const NativeSheetWindow = requireNativeViewManager<
  ViewProps & {
    active: boolean;
    onGeometryChange: (event: NativeSyntheticEvent<SheetGeometry>) => void;
  }
>("PaseoWindowLayout", "SheetWindowView");

/** One native presentation owns the existing Gorhom stack, not one presentation per sheet. */
export function SheetWindowHost({ children }: { children: ReactNode }) {
  const parent = useBottomSheetModalInternal();
  const { mountSheet: mountParentSheet, unmountSheet: unmountParentSheet } = parent;
  const layout = useWindowLayout();
  const hostName = `sheet-window-${useId()}`;
  const mounted = useRef(new Set<string>());
  const [nativeWindow, setNativeWindow] = useState<boolean | null>(null);
  const [geometry, setGeometry] = useState<SheetGeometry | null>(null);
  const containerLayoutState = useSharedValue({ ...INITIAL_CONTAINER_LAYOUT });
  const needsNativeWindow = resolveWorkspaceActionPlacement(layout) === "vertical-bar";
  // Freeze the presentation choice until the stack empties, including across guide changes.
  const enabled = nativeWindow ?? needsNativeWindow;
  const mountSheet = useCallback<typeof mountParentSheet>(
    (key, ...args) => {
      if (mounted.current.size === 0) setNativeWindow(needsNativeWindow);
      mounted.current.add(key);
      mountParentSheet(key, ...args);
    },
    [mountParentSheet, needsNativeWindow],
  );
  const unmountSheet = useCallback<typeof unmountParentSheet>(
    (key) => {
      unmountParentSheet(key);
      mounted.current.delete(key);
      if (mounted.current.size === 0) {
        setNativeWindow(null);
        setGeometry(null);
      }
    },
    [unmountParentSheet],
  );
  const handleGeometry = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<SheetGeometry>) => {
      containerLayoutState.value = {
        height: nativeEvent.bounds.height,
        offset: { top: 0, bottom: 0, left: 0, right: 0 },
      };
      setGeometry(nativeEvent);
    },
    [containerLayoutState],
  );
  const host = useMemo(
    () => ({
      ...parent,
      mountSheet,
      unmountSheet,
      ...(enabled ? { hostName, containerLayoutState } : undefined),
    }),
    [enabled, parent, hostName, containerLayoutState, mountSheet, unmountSheet],
  );
  const presentation = useMemo(
    () => ({ enabled, topInset: geometry?.insets.top ?? 0 }),
    [enabled, geometry?.insets.top],
  );

  return (
    <SheetWindowContext.Provider value={presentation}>
      <BottomSheetModalInternalProvider value={host}>
        {children}
        {enabled ? (
          <NativeSheetWindow
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            active={nativeWindow === true}
            onGeometryChange={handleGeometry}
          >
            {geometry ? <SheetWindowContent geometry={geometry} hostName={hostName} /> : null}
          </NativeSheetWindow>
        ) : null}
      </BottomSheetModalInternalProvider>
    </SheetWindowContext.Provider>
  );
}

function SheetWindowContent({ geometry, hostName }: { geometry: SheetGeometry; hostName: string }) {
  const metrics = useMemo(() => ({ frame: geometry.bounds, insets: geometry.insets }), [geometry]);
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider initialMetrics={metrics}>
        <AppWindowFrameContext.Provider value={geometry.bounds}>
          <AppWindowCompactContext.Provider value={geometry.bounds.width < LAYOUT_BREAKPOINTS.md}>
            <SheetWindowChrome>
              <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                <PortalHost name={hostName} />
              </View>
            </SheetWindowChrome>
          </AppWindowCompactContext.Provider>
        </AppWindowFrameContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function SheetWindowChrome({ children }: { children: ReactNode }) {
  return (
    <WindowLayoutContext.Provider value={null}>
      <TopBandContext.Provider value={null}>
        <WindowChromeRootRegion corners="both">{children}</WindowChromeRootRegion>
      </TopBandContext.Provider>
    </WindowLayoutContext.Provider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
