import type { ReactNode, Ref } from "react";
import type { View, ViewProps, ViewStyle } from "react-native";
import type { LayoutAnimationFunction } from "react-native-reanimated";

export interface ComposerSurfaceTransition {
  prepare?: (collapsed: boolean) => void;
  layout?: LayoutAnimationFunction;
}

export interface ComposerSurfaceFrameProps {
  children: ReactNode;
  focusSurface: ReactNode;
  inputWrapperRef: Ref<View>;
  style?: ViewStyle;
  pointerEvents: ViewProps["pointerEvents"];
  layoutTransition?: LayoutAnimationFunction;
  fullscreen: boolean;
  collapsed: boolean;
  collapseInLandscape?: boolean;
  isCompact: boolean;
  readOnly: boolean;
  opacity: number;
}
