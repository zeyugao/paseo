import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  COMPOSER_CORNER_RADIUS,
  COMPOSER_PADDING_BOTTOM,
  COMPOSER_PADDING_HORIZONTAL,
  COMPOSER_PADDING_TOP,
} from "./toolbar-rails";
import type { ComposerSurfaceFrameProps, ComposerSurfaceTransition } from "./surface-frame.types";

const NO_SURFACE_TRANSITION: ComposerSurfaceTransition = {};

export function useComposerSurfaceTransition(
  _collapsed: boolean,
  _fullscreen: boolean,
): ComposerSurfaceTransition {
  return NO_SURFACE_TRANSITION;
}

export function ComposerSurfaceFrame({
  children,
  focusSurface,
  inputWrapperRef,
  style,
  pointerEvents,
  fullscreen,
  collapsed,
  isCompact,
  readOnly,
  opacity,
}: ComposerSurfaceFrameProps) {
  return (
    <View
      ref={inputWrapperRef}
      style={
        fullscreen
          ? styles.fullscreen
          : [
              styles.surface,
              isCompact && styles.compact,
              readOnly && styles.readOnly,
              inlineUnistylesStyle({
                paddingTop: (collapsed ? COMPOSER_PADDING_BOTTOM : COMPOSER_PADDING_TOP)[
                  isCompact ? "xs" : "md"
                ],
              }),
              style,
              { opacity },
            ]
      }
      pointerEvents={pointerEvents}
    >
      {focusSurface}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: {
    flexShrink: 1,
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: COMPOSER_CORNER_RADIUS,
    paddingTop: COMPOSER_PADDING_TOP,
    paddingBottom: COMPOSER_PADDING_BOTTOM,
    paddingHorizontal: COMPOSER_PADDING_HORIZONTAL,
    transitionProperty: "border-color",
    transitionDuration: "200ms",
    transitionTimingFunction: "ease-in-out",
  },
  compact: { ...theme.shadow.sm },
  readOnly: { borderStyle: "dotted" },
  fullscreen: { flex: 1, minHeight: 0 },
}));
