import { useState } from "react";
import { StyleSheet, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import type { WindowLayoutInsetSurfaceProps } from "./inset-surface";
import { WindowLayoutGeometryView } from "./react-layout-view";

const NativeHorizontalInset = requireNativeViewManager<
  ViewProps & { trailing?: boolean; compact: boolean; unownedInset: number }
>("PaseoWindowLayout", "WindowLayoutHorizontalInsetView");

export function WindowLayoutInsetSurface({
  children,
  style,
  compact,
  usesBar,
  insets,
}: WindowLayoutInsetSurfaceProps) {
  const consumesInsets = !compact || usesBar;
  // Seed once; the owning native window updates these Yoga widths during resize,
  // before React receives the new geometry snapshot.
  const [seed] = useState(() => ({
    left: consumesInsets ? insets.left : 0,
    right: consumesInsets ? insets.right : 0,
  }));
  return (
    <WindowLayoutGeometryView style={style}>
      <NativeHorizontalInset
        pointerEvents="none"
        compact={compact}
        unownedInset={consumesInsets ? insets.left : 0}
        style={[styles.inset, { width: seed.left }]}
      />
      {children}
      <NativeHorizontalInset
        pointerEvents="none"
        trailing
        compact={compact}
        unownedInset={consumesInsets ? insets.right : 0}
        style={[styles.inset, { width: seed.right }]}
      />
    </WindowLayoutGeometryView>
  );
}

const styles = StyleSheet.create({ inset: { flexShrink: 0 } });
