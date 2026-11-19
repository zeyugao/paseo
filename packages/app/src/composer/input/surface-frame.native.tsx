import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  type LayoutAnimationFunction,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { withUnistyles } from "react-native-unistyles";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import {
  COMPOSER_CORNER_RADIUS,
  COMPOSER_PADDING_BOTTOM,
  COMPOSER_PADDING_HORIZONTAL,
  COMPOSER_PADDING_TOP,
} from "./toolbar-rails";
import type { ComposerSurfaceFrameProps, ComposerSurfaceTransition } from "./surface-frame.types";
import { WindowLayoutVariantView, type WindowLayoutVariants } from "@/window-layout/variant-view";

const TIMING = { duration: 180, easing: Easing.out(Easing.cubic) };

export function useComposerSurfaceTransition(
  collapsed: boolean,
  fullscreen: boolean,
): ComposerSurfaceTransition {
  const reducedMotion = useReducedMotion();
  const { width: windowWidth, height: windowHeight } = useAppWindowSize();
  const lastMode = useSharedValue(collapsed);
  // JS publishes the requested geometry; the UI thread only consumes the armed bit.
  // Reading a shared value from a layout effect blocks on the UI thread precisely
  // when UIKit and Fabric are laying out the new viewport.
  const requestedGeometry = useRef({ collapsed, fullscreen, windowWidth, windowHeight });
  const request = useSharedValue({ ...requestedGeometry.current, armed: false });
  useLayoutEffect(() => {
    const previous = requestedGeometry.current;
    if (
      previous.collapsed !== collapsed ||
      previous.fullscreen !== fullscreen ||
      previous.windowWidth !== windowWidth ||
      previous.windowHeight !== windowHeight
    ) {
      const next = { collapsed, fullscreen, windowWidth, windowHeight };
      requestedGeometry.current = next;
      request.value = { ...next, armed: false };
      lastMode.value = collapsed;
    }
  }, [collapsed, fullscreen, windowWidth, windowHeight, request, lastMode]);
  const prepare = useCallback(
    (nextCollapsed: boolean) => {
      const next = { collapsed: nextCollapsed, fullscreen, windowWidth, windowHeight };
      requestedGeometry.current = next;
      request.value = {
        ...next,
        armed:
          !reducedMotion &&
          !fullscreen &&
          windowWidth > windowHeight &&
          collapsed !== nextCollapsed,
      };
    },
    [collapsed, fullscreen, windowWidth, windowHeight, reducedMotion, request],
  );
  // Keep the native builder registered before the focus event commits its Yoga
  // layout. A newly registered builder can miss that first native mutation.
  const layout = useMemo<LayoutAnimationFunction>(
    () => (values) => {
      "worklet";
      const next = request.value;
      const modeChanged = lastMode.value !== next.collapsed;
      const sameGeometry =
        Math.abs(next.windowWidth - values.windowWidth) < 0.5 &&
        Math.abs(next.windowHeight - values.windowHeight) < 0.5 &&
        Math.abs(values.currentWidth - values.targetWidth) < 0.5 &&
        Math.abs(values.currentOriginX - values.targetOriginX) < 0.5;
      const heightChanged = Math.abs(values.currentHeight - values.targetHeight) >= 0.5;
      const animate = next.armed && modeChanged && sameGeometry && heightChanged;
      if (heightChanged || !sameGeometry) {
        lastMode.value = next.collapsed;
        if (next.armed) request.value = { ...next, armed: false };
      }
      const target = {
        originX: values.targetOriginX,
        originY: values.targetOriginY,
        width: values.targetWidth,
        height: values.targetHeight,
      };
      // A native resize can precede React's new window snapshot. Replace every
      // frame property, including any in-flight focus animation.
      return {
        // The intrinsic parent already has its target height. Offset this frame
        // in that parent so the painted bottom stays anchored during focus.
        initialValues: animate
          ? {
              originX: values.currentOriginX,
              originY: values.targetOriginY + values.targetHeight - values.currentHeight,
              width: values.currentWidth,
              height: values.currentHeight,
            }
          : target,
        animations: {
          originX: target.originX,
          originY: animate ? withTiming(target.originY, TIMING) : target.originY,
          width: target.width,
          height: animate ? withTiming(target.height, TIMING) : target.height,
        },
      };
    },
    [request, lastMode],
  );
  return useMemo(() => ({ prepare, layout }), [prepare, layout]);
}

function NativeComposerSurfaceFrame({
  children,
  focusSurface,
  inputWrapperRef,
  style,
  pointerEvents,
  layoutTransition,
  fullscreen,
  collapsed,
  collapseInLandscape = false,
  isCompact,
  readOnly,
  opacity,
  surfaceColors,
  surfaceShadow,
}: ComposerSurfaceFrameProps & { surfaceColors: ViewStyle; surfaceShadow: ViewStyle }) {
  const sizing = isCompact ? "xs" : "md";
  const nativeLayout = Platform.OS === "ios" && !fullscreen;
  const paddingLayout = useMemo<WindowLayoutVariants>(
    () => ({
      expanded: { paddingTop: COMPOSER_PADDING_TOP[sizing] },
      collapsed: { paddingTop: COMPOSER_PADDING_BOTTOM[sizing] },
    }),
    [sizing],
  );
  return (
    <Animated.View
      ref={inputWrapperRef}
      layout={layoutTransition}
      style={[
        styles.frame,
        fullscreen
          ? styles.fullscreen
          : [
              styles.surface,
              surfaceColors,
              {
                borderRadius: COMPOSER_CORNER_RADIUS[sizing],
                paddingTop: nativeLayout
                  ? undefined
                  : (collapsed ? COMPOSER_PADDING_BOTTOM : COMPOSER_PADDING_TOP)[sizing],
                paddingBottom: COMPOSER_PADDING_BOTTOM[sizing],
                paddingHorizontal: COMPOSER_PADDING_HORIZONTAL[sizing],
                borderStyle: readOnly ? "dotted" : "solid",
              },
              Platform.OS !== "ios" && isCompact && surfaceShadow,
              style,
              { opacity },
            ],
      ]}
      pointerEvents={pointerEvents}
    >
      {focusSurface}
      <WindowLayoutVariantView
        style={[styles.content, fullscreen && styles.fullscreen]}
        variants={nativeLayout ? paddingLayout : undefined}
        collapsed={collapsed}
        collapseInLandscape={collapseInLandscape}
      >
        {children}
      </WindowLayoutVariantView>
    </Animated.View>
  );
}

// Map plain paint props at this leaf: neither a Unistyles shadow registration
// nor a second painted child may compete with the animated native frame.
export const ComposerSurfaceFrame = withUnistyles(NativeComposerSurfaceFrame, (theme) => ({
  surfaceColors: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  surfaceShadow: theme.shadow.sm,
}));

const styles = StyleSheet.create({
  frame: { flexShrink: 1 },
  surface: {
    ...(Platform.OS === "ios" ? { overflow: "hidden" as const } : {}),
    borderWidth: 1,
    flexDirection: "column",
    gap: 12,
  },
  content: { flexShrink: 1, gap: 12 },
  fullscreen: { flex: 1, minHeight: 0 },
});
