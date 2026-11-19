import { View, type ViewProps, type ViewStyle } from "react-native";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export interface WindowLayoutVariants {
  expanded: ViewStyle;
  collapsed: ViewStyle;
}

export interface WindowLayoutVariantViewProps extends ViewProps {
  variants?: WindowLayoutVariants;
  collapsed: boolean;
  collapseInLandscape: boolean;
  windowBarRole?: "host" | "header-actions" | "header-navigation" | "bar-navigation";
  /** Omit horizontalPadding for the strip below the top-right obstruction. */
  headerChrome?: { left: boolean; right: boolean; horizontalPadding?: number };
  /** Apply the window's mirrored horizontal clearance to undocked content. */
  centerContent?: boolean;
  /** Height caps for an editor slot, resolved against its owning viewport. */
  viewportHeightLimit?: { collapsed: number; minimumExpanded: number; expandedFraction: number };
  /** Keep the native editor's placeholder in step with the collapsed display label. */
  editorPlaceholder?: string;
}

export function WindowLayoutVariantView({
  variants,
  collapsed,
  collapseInLandscape: _collapseInLandscape,
  windowBarRole: _windowBarRole,
  headerChrome: _headerChrome,
  centerContent: _centerContent,
  viewportHeightLimit: _viewportHeightLimit,
  editorPlaceholder: _editorPlaceholder,
  style,
  ...props
}: WindowLayoutVariantViewProps) {
  const selected = collapsed ? variants?.collapsed : variants?.expanded;
  return <View {...props} style={[style, selected && inlineUnistylesStyle(selected)]} />;
}
