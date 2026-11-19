import { useState } from "react";
import type { ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { requireNativeViewManager } from "expo-modules-core";
import { useTopBand, useWindowLayout } from "./context";
import type { WindowLayoutTopInsetProps } from "./top-inset";

const NativeTopInset = requireNativeViewManager<
  ViewProps & { additionalPadding: number; landscapePadding: number; unownedInset: number }
>("PaseoWindowLayout", "WindowLayoutTopInsetView");

export function WindowLayoutTopInset({
  additionalPadding = 0,
  landscapePadding = 0,
}: WindowLayoutTopInsetProps) {
  const insets = useSafeAreaInsets();
  const topBand = useTopBand();
  const layout = useWindowLayout();
  // Seed Yoga's first commit; native setStyleSize owns subsequent geometry.
  // Without a seed, a newly mounted workspace briefly paints with zero clearance.
  const [insetStyle] = useState(() => {
    let padding = topBand ? 0 : additionalPadding;
    if (layout && layout.bounds.width > layout.bounds.height && landscapePadding > 0) {
      padding = landscapePadding;
    }
    return { flexShrink: 0, height: insets.top + padding };
  });
  const unownedInset = insets.top + (topBand ? 0 : additionalPadding);
  return (
    <NativeTopInset
      pointerEvents="none"
      style={insetStyle}
      additionalPadding={additionalPadding}
      landscapePadding={landscapePadding}
      unownedInset={unownedInset}
    />
  );
}
