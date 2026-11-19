import { useMemo, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement, type DesktopDivisionLayout } from "./model";
import { WindowLayoutInsetSurface } from "./inset-surface";
import { WindowLayoutGeometryView } from "./react-layout-view";

/** Consume horizontal safe areas once, including compact content beside a vertical bar. */
export function WindowLayoutSurface({
  children,
  compact,
  style,
}: {
  children: ReactNode;
  compact: boolean;
  style: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const usesBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const contentInsets = useMemo(
    () => (compact && usesBar ? { ...insets, left: 0, right: 0 } : insets),
    [compact, usesBar, insets],
  );
  return (
    <WindowLayoutInsetSurface style={style} compact={compact} usesBar={usesBar} insets={insets}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </WindowLayoutInsetSurface>
  );
}

export function WindowLayoutDivisionGap({
  layout,
  sidebarVisible,
  compact,
}: {
  layout: DesktopDivisionLayout | null;
  sidebarVisible: boolean;
  compact: boolean;
}) {
  const style = useMemo(
    () => ({
      width: layout ? layout.gap + (sidebarVisible ? 0 : layout.sidebarWidth) : 0,
    }),
    [layout, sidebarVisible],
  );
  return !compact && layout ? (
    <WindowLayoutGeometryView style={[styles.divisionGap, style]} />
  ) : null;
}

const styles = StyleSheet.create((theme) => ({
  divisionGap: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
}));
