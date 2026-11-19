import {
  use,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { StyleSheet, type ViewProps } from "react-native";
import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import { SafeAreaFrameContext, SafeAreaInsetsContext } from "react-native-safe-area-context";
import { AppWindowCompactContext, AppWindowFrameContext } from "@/hooks/app-window-frame-context";
import { TopBandContext, WindowInsetsContext, WindowLayoutContext } from "./context";
import { resolveSafeAreaInsets, type WindowLayout } from "./model";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { LAYOUT_BREAKPOINTS } from "@/constants/layout-breakpoints";

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

interface WindowGeometryModule {
  addListener(
    event: "onWindowGeometryChange",
    handler: (event: { sourceId: string; geometry: WindowLayout }) => void,
  ): { remove(): void };
}

const geometryEvents = requireNativeModule<WindowGeometryModule>("PaseoWindowLayout");

const GeometryProbe = requireNativeViewManager<
  ViewProps & {
    topChromeRowHeight: number;
    geometrySourceId: string;
  }
>("PaseoWindowLayout", "WindowLayoutView");

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [observing, setObserving] = useState(false);
  const [snapshotSource] = useState(() => {
    let snapshot: WindowLayout | null = null;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      update: (next: WindowLayout) => {
        snapshot = next;
        listeners.forEach((listener) => listener());
      },
    };
  });
  const geometry = useSyncExternalStore(snapshotSource.subscribe, snapshotSource.getSnapshot);
  const sourceId = useId();
  useLayoutEffect(() => {
    const subscription = geometryEvents.addListener("onWindowGeometryChange", (event) => {
      if (event.sourceId === sourceId) {
        snapshotSource.update(event.geometry);
      }
    });
    // Activate only after subscribing; native republishes its current snapshot.
    setObserving(true);
    return () => {
      subscription.remove();
    };
  }, [sourceId, snapshotSource]);
  const compact = geometry === null ? null : geometry.bounds.width < LAYOUT_BREAKPOINTS.md;
  return (
    <AppWindowFrameContext.Provider value={geometry?.bounds ?? null}>
      <AppWindowCompactContext.Provider value={compact}>
        <WindowLayoutContext.Provider value={geometry}>
          <GeometryProbe
            style={styles.root}
            topChromeRowHeight={HEADER_INNER_HEIGHT}
            geometrySourceId={observing ? sourceId : ""}
          >
            <WindowSafeAreaInsets>{children}</WindowSafeAreaInsets>
          </GeometryProbe>
        </WindowLayoutContext.Provider>
      </AppWindowCompactContext.Provider>
    </AppWindowFrameContext.Provider>
  );
}

/** Allocation owners read bounds and clearances from one complete native transaction. */
export function useWindowLayoutViewport() {
  const geometry = useContext(WindowLayoutContext);
  const frame = use(AppWindowFrameContext) ?? use(SafeAreaFrameContext);
  const insets = use(SafeAreaInsetsContext);
  if (!frame || !insets) throw new Error("Render SafeAreaProvider above window layout.");
  return { geometry, width: frame.width, height: frame.height, insets };
}

/**
 * The one top and bottom inset every descendant reads through `useSafeAreaInsets()`, and
 * the top band that `WindowChromeProvider` reads through `useTopBand()`.
 */
function WindowSafeAreaInsets({ children }: { children: ReactNode }) {
  // Once acquired, only this window's native snapshot owns geometry. Reading
  // the outer fallback would publish stale insets again during native resize.
  const layout = useContext(WindowLayoutContext);
  const systemInsets = layout?.insets ?? use(SafeAreaInsetsContext);
  if (!systemInsets) {
    throw new Error(
      "No safe area insets value available. Render SafeAreaProvider at the app root.",
    );
  }
  const insets = useMemo(() => resolveSafeAreaInsets(systemInsets, layout), [systemInsets, layout]);
  const topBand = layout?.topBand ?? null;
  return (
    <TopBandContext.Provider value={topBand}>
      <WindowInsetsContext.Provider value={insets}>
        <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>
      </WindowInsetsContext.Provider>
    </TopBandContext.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
