import { useMemo, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { WindowLayoutGeometryView } from "./react-layout-view";

export interface WindowLayoutInsetSurfaceProps {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  compact: boolean;
  usesBar: boolean;
  insets: Pick<EdgeInsets, "left" | "right">;
}

export function WindowLayoutInsetSurface({
  children,
  style,
  compact,
  usesBar,
  insets,
}: WindowLayoutInsetSurfaceProps) {
  const surfaceStyle = useMemo(
    () => [
      style,
      (!compact || usesBar) && { paddingLeft: insets.left, paddingRight: insets.right },
    ],
    [style, compact, usesBar, insets.left, insets.right],
  );
  return <WindowLayoutGeometryView style={surfaceStyle}>{children}</WindowLayoutGeometryView>;
}
