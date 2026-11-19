import { useMemo } from "react";
import type { ViewProps, ViewStyle } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { LAYOUT_BREAKPOINTS } from "@/constants/layout-breakpoints";
import type { WindowLayoutVariantViewProps, WindowLayoutVariants } from "./variant-view";

const NativeVariantView = requireNativeViewManager<
  ViewProps & {
    expandedLayout?: Readonly<Record<string, unknown>>;
    collapsedLayout?: Readonly<Record<string, unknown>>;
    collapseInLandscape: boolean;
    windowBarRole?: WindowLayoutVariantViewProps["windowBarRole"];
    wideWindowMinWidth?: number;
    headerChrome?: WindowLayoutVariantViewProps["headerChrome"];
    centerContent?: boolean;
    viewportHeightLimit?: WindowLayoutVariantViewProps["viewportHeightLimit"];
    editorPlaceholder?: string;
  }
>("PaseoWindowLayout", "WindowLayoutVariantView");

function completeLayout(layout: ViewStyle, other: ViewStyle) {
  // Removing an inline property in the next mode must reset the native prop.
  const complete: Record<string, unknown> = {};
  for (const key of Object.keys(other)) complete[key] = null;
  for (const [key, value] of Object.entries(layout)) complete[key] = value ?? null;
  return complete;
}

function resolveNativeVariants(variants: WindowLayoutVariants | undefined) {
  return (
    variants && {
      expandedLayout: completeLayout(variants.expanded, variants.collapsed),
      collapsedLayout: completeLayout(variants.collapsed, variants.expanded),
    }
  );
}

export function WindowLayoutVariantView({
  variants,
  collapsed,
  collapseInLandscape,
  windowBarRole,
  centerContent,
  viewportHeightLimit,
  editorPlaceholder,
  style,
  ...props
}: WindowLayoutVariantViewProps) {
  const nativeVariants = useMemo(() => resolveNativeVariants(variants), [variants]);
  const movesNavigation =
    windowBarRole === "header-navigation" || windowBarRole === "bar-navigation";
  return (
    <NativeVariantView
      {...props}
      {...nativeVariants}
      collapseInLandscape={collapseInLandscape}
      windowBarRole={windowBarRole}
      centerContent={centerContent}
      wideWindowMinWidth={
        movesNavigation || viewportHeightLimit ? LAYOUT_BREAKPOINTS.md : undefined
      }
      viewportHeightLimit={viewportHeightLimit}
      editorPlaceholder={editorPlaceholder}
      style={[style, collapsed ? variants?.collapsed : variants?.expanded]}
    />
  );
}
