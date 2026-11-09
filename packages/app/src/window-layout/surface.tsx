import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement, type DesktopDivisionLayout } from "./model";

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
  const usesVerticalBarActions =
    resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const consumesHorizontalInsets = !compact || usesVerticalBarActions;
  const overridesCompactInsets = compact && consumesHorizontalInsets;
  // Wide sidebar allocation still needs window-space insets. Only compact
  // descendants use this override to avoid repeating the shell's clearance.
  const contentInsets = useMemo(
    () => (overridesCompactInsets ? { ...insets, left: 0, right: 0 } : insets),
    [overridesCompactInsets, insets],
  );
  // Column allocation reads these same JS insets. A native SafeAreaView updates
  // its padding in a separate Fabric commit and shifts the columns again after rotation.
  const horizontalPadding = useMemo(
    () =>
      consumesHorizontalInsets
        ? { paddingLeft: insets.left, paddingRight: insets.right }
        : undefined,
    [consumesHorizontalInsets, insets.left, insets.right],
  );
  return (
    <View style={[style, horizontalPadding]}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
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
  return !compact && layout ? <View style={[styles.divisionGap, style]} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  divisionGap: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
}));
