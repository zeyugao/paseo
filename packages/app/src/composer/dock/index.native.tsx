import { ComposerDockBackground } from "./internal/background";
export { ComposerDockBackground } from "./internal/background";
export { ComposerFullscreenBody, ComposerFullscreenFooter } from "./internal/fullscreen";
import { ScrollView } from "@/components/ui/scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { resolveContentMaxWidth, useAppSettings } from "@/hooks/use-settings";
import { useWindowLayout, resolveWorkspaceActionPlacement } from "@/window-layout";
import {
  WindowLayoutContentAllocationContext,
  WindowLayoutPaneWidthContext,
} from "@/window-layout/context";
import { resolveSafeAreaInsets } from "@/window-layout/model";
import { WindowLayoutVariantView } from "@/window-layout/variant-view";
import { KeyboardTranslateView } from "@/keyboard/shift";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type ViewProps, StyleSheet } from "react-native";
import { StyleSheet as ThemedStyleSheet } from "react-native-unistyles";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useAnimatedReaction,
  type SharedValue,
} from "react-native-reanimated";
import { useKeyboardShift } from "@/keyboard/shift";
import {
  resolveCenteredClearance,
  resolveComposerBarCompensation,
  resolveComposerBottomPlacement,
  resolveComposerSlotCapacity,
  updateComposerCapacity,
  type ComposerCapacity,
} from "./internal/capacity";
import { SPACING } from "@/styles/theme";
import { ComposerDockContentInsetsContext, ComposerLayoutWidthContext } from "./content-insets";

const ViewportSizing = createContext<SharedValue<ComposerCapacity | undefined> | null>(null);

interface ComposerViewportProps extends ViewProps {
  bottomInset?: number;
  keyboardGap?: number;
  centered?: boolean;
}

/** Measure the stationary space below the header, outside keyboard translation. */
function ComposerViewport({
  children,
  onLayout,
  bottomInset = 0,
  keyboardGap = 0,
  centered = false,
  ...props
}: ComposerViewportProps) {
  const measuredHeight = useSharedValue(0);
  const sizing = useSharedValue<ComposerCapacity | undefined>(undefined);
  const { layoutShift, bottomInset: safeAreaBottom } = useKeyboardShift();
  useAnimatedReaction(
    () => ({
      height: measuredHeight.value,
      bottomInset,
      safeAreaBottom: safeAreaBottom.value,
      keyboardShift: layoutShift.value,
      keyboardGap,
      centered,
    }),
    (geometry) => {
      if (geometry.height <= 0) return;
      sizing.value = updateComposerCapacity(sizing.value, geometry);
    },
    [],
  );
  const measureViewport = useCallback(
    (event: LayoutChangeEvent) => {
      measuredHeight.value = event.nativeEvent.layout.height;
      onLayout?.(event);
    },
    [measuredHeight, onLayout],
  );

  return (
    <View testID="composer-viewport" {...props} onLayout={measureViewport} collapsable={false}>
      <ViewportSizing.Provider value={sizing}>{children}</ViewportSizing.Provider>
    </View>
  );
}

/** Bound the complete composer (including its controls), not just the text input. */
function ComposerViewportContent({
  style,
  fullscreen = false,
  ...props
}: ViewProps & { fullscreen?: boolean }) {
  const compact = useIsCompactFormFactor();
  const sizing = useContext(ViewportSizing);
  if (!sizing) throw new Error("ComposerViewportContent requires ComposerViewport");
  const constraint = useAnimatedStyle(() => ({
    // Only viewport changes and keyboard start/end events trigger layout. Motion
    // stays in KeyboardTranslateView and never changes this constraint per frame.
    maxHeight: resolveComposerSlotCapacity(sizing.value, { compact, fullscreen }),
  }));

  return (
    <Animated.View testID="composer-viewport-content" {...props} style={[style, constraint]} />
  );
}

/** The keyboard only needs to move a centered form once it reaches the form's resting bottom. */
function useCenteredClearance(safeAreaBottom: number) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [formBottom, setFormBottom] = useState(0);
  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    setViewportHeight(event.nativeEvent.layout.height);
  }, []);
  const measureForm = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setFormBottom(y + height);
  }, []);
  return {
    value: resolveCenteredClearance({ viewportHeight, safeAreaBottom, formBottom }),
    measureViewport,
    measureForm,
  };
}

interface ComposerDockProps {
  children: [ReactNode, ReactNode, ReactNode?];
  centered?: boolean;
  /**
   * Fullscreen is a layout mode of the same mounted composer: the slot fills the
   * stationary viewport over the content and lays out the keyboard itself, so the
   * surface stops translating. The screen that owns the chrome hides it.
   */
  fullscreen?: boolean;
}

function useDockHorizontalLayout(
  insets: ReturnType<typeof useSafeAreaInsets>,
  centered: boolean,
  fullscreen: boolean,
) {
  const windowLayout = useWindowLayout();
  const paneWidth = useContext(WindowLayoutPaneWidthContext);
  const hasPinnedSidebar =
    useContext(WindowLayoutContentAllocationContext)?.hasPinnedSidebar ?? false;
  const nativeCentering = centered ? null : windowLayout?.contentCenteringInsets;
  const centerContent = nativeCentering != null && !hasPinnedSidebar && !fullscreen;
  const usesNativeCentering = nativeCentering != null;
  const [viewport, setViewport] = useState(() => ({ width: 0, height: 0 }));
  const measureViewport = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (!usesNativeCentering) {
        setViewport((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }
    },
    [usesNativeCentering],
  );
  const balancedViewportStyle = useMemo(() => {
    // Full-display chat and editor are padded by a single Fabric layout node.
    if (nativeCentering != null) return { paddingLeft: 0, paddingRight: 0 };
    const windowInsets = resolveSafeAreaInsets(insets, windowLayout);
    // The viewport is already allocated after the header, native bar, and docked sidebars.
    const balance =
      !fullscreen &&
      !hasPinnedSidebar &&
      resolveWorkspaceActionPlacement(windowLayout) === "vertical-bar"
        ? resolveComposerBarCompensation({
            isExpandedDisplay:
              windowLayout?.hingeStatus === "partially-open" ||
              windowLayout?.hingeStatus === "fully-open",
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            left: windowInsets.left,
            right: windowInsets.right,
          })
        : 0;
    return { paddingLeft: Math.max(0, balance), paddingRight: Math.max(0, -balance) };
  }, [fullscreen, hasPinnedSidebar, viewport, windowLayout, insets, nativeCentering]);
  const centeringWidth = centerContent ? nativeCentering.left + nativeCentering.right : 0;
  const contentInsets = useMemo(
    () => ({ ...balancedViewportStyle, nativeHorizontalPadding: centeringWidth }),
    [balancedViewportStyle, centeringWidth],
  );
  const horizontalPadding = fullscreen
    ? insets.left + insets.right
    : centeringWidth + balancedViewportStyle.paddingLeft + balancedViewportStyle.paddingRight;
  const composerWidth = paneWidth === null ? null : Math.max(0, paneWidth - horizontalPadding);
  return {
    centerContent,
    usesNativeCentering,
    measureViewport,
    balancedViewportStyle,
    contentInsets,
    composerWidth,
  };
}

/** The stationary viewport, translated surface, and bounded composer are one owner. */
export function ComposerDock({
  children: [content, composer, overlay],
  centered = false,
  fullscreen = false,
}: ComposerDockProps) {
  const insets = useSafeAreaInsets();
  const {
    centerContent,
    usesNativeCentering,
    measureViewport,
    balancedViewportStyle,
    contentInsets,
    composerWidth,
  } = useDockHorizontalLayout(insets, centered, fullscreen);
  const centeredClearance = useCenteredClearance(insets.bottom);
  const { measureViewport: measureCenteredViewport } = centeredClearance;
  const onCenteredLayout = useCallback(
    (event: LayoutChangeEvent) => {
      measureViewport(event);
      measureCenteredViewport(event);
    },
    [measureViewport, measureCenteredViewport],
  );
  const contentMaxWidth = resolveContentMaxWidth(useAppSettings().settings);
  const placement = resolveComposerBottomPlacement({
    safeAreaBottom: insets.bottom,
    contentSpacing: SPACING[4],
  });
  // Preserve the existing centered form's visual balance on tablets.
  const bottomInset = centered && !fullscreen ? HEADER_INNER_HEIGHT + 24 : 0;
  const fullscreenSurface = [
    themedStyles.fullscreenComposer,
    {
      paddingTop: insets.top,
      paddingBottom: insets.bottom,
      paddingLeft: insets.left,
      paddingRight: insets.right,
    },
  ];
  if (centered) {
    // Same tree in both modes. Fullscreen stops centering and translating, hides the
    // setup fields, and lets the composer slot take the whole stationary viewport.
    return (
      <ComposerViewport
        style={
          fullscreen
            ? dockStyles.viewport
            : [dockStyles.centeredViewport, balancedViewportStyle, { paddingBottom: bottomInset }]
        }
        bottomInset={bottomInset}
        centered
        onLayout={onCenteredLayout}
      >
        <KeyboardTranslateView
          style={
            fullscreen ? dockStyles.surface : [dockStyles.centered, { maxWidth: contentMaxWidth }]
          }
          enabled={!fullscreen}
          bottomClearance={centeredClearance.value}
          onLayout={centeredClearance.measureForm}
        >
          <ComposerViewportContent
            style={fullscreen ? dockStyles.surface : dockStyles.composer}
            fullscreen={fullscreen}
          >
            <ScrollView
              style={fullscreen ? dockStyles.hiddenSetup : dockStyles.setup}
              keyboardShouldPersistTaps="handled"
            >
              {content}
            </ScrollView>
            <ComposerViewportContent
              style={fullscreen ? dockStyles.surface : dockStyles.centeredComposer}
              fullscreen={fullscreen}
            >
              <View style={fullscreen ? fullscreenSurface : dockStyles.centeredComposerSurface}>
                {composer}
              </View>
            </ComposerViewportContent>
          </ComposerViewportContent>
        </KeyboardTranslateView>
        {overlay}
      </ComposerViewport>
    );
  }
  return (
    <ComposerViewport
      style={dockStyles.viewport}
      keyboardGap={placement.keyboardGap}
      onLayout={usesNativeCentering ? undefined : measureViewport}
    >
      <KeyboardTranslateView
        style={dockStyles.surface}
        enabled={!fullscreen}
        keyboardGap={placement.keyboardGap}
      >
        <WindowLayoutVariantView
          centerContent={centerContent}
          collapsed={false}
          collapseInLandscape={false}
          style={dockStyles.surface}
          pointerEvents="box-none"
        >
          <View
            testID="composer-dock-content"
            collapsable={false}
            style={dockStyles.content}
            pointerEvents="box-none"
          >
            {/* A responder ancestor intercepts native scroll drags on Android Fabric.
                Only unclaimed background touches may reach this sibling. */}
            <ComposerDockBackground style={StyleSheet.absoluteFill} />
            <ComposerDockContentInsetsContext.Provider value={contentInsets}>
              <View style={dockStyles.content} pointerEvents="box-none">
                {content}
              </View>
            </ComposerDockContentInsetsContext.Provider>
          </View>
          <ComposerViewportContent
            style={
              fullscreen ? dockStyles.fullscreenSlot : [dockStyles.composer, balancedViewportStyle]
            }
            fullscreen={fullscreen}
          >
            <View
              style={
                fullscreen
                  ? fullscreenSurface
                  : [dockStyles.composer, { paddingBottom: placement.restingPadding }]
              }
            >
              <ComposerLayoutWidthContext.Provider value={composerWidth}>
                {composer}
              </ComposerLayoutWidthContext.Provider>
            </View>
          </ComposerViewportContent>
        </WindowLayoutVariantView>
      </KeyboardTranslateView>
      {overlay}
    </ComposerViewport>
  );
}

// Plain React Native styles: these land on Reanimated views, which must not carry
// theme-driven Unistyles (docs/unistyles.md). The content width arrives inline.
const dockStyles = StyleSheet.create({
  viewport: { flex: 1, overflow: "hidden" },
  surface: { flex: 1 },
  content: { flex: 1, justifyContent: "flex-end" },
  composer: { width: "100%", flexShrink: 1 },
  fullscreenSlot: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  centeredViewport: { flex: 1, alignItems: "center", justifyContent: "center" },
  centered: { flexShrink: 1, width: "100%" },
  // Reserve the composer's own capped height before the setup scroll view shrinks.
  centeredComposer: { width: "100%", flexShrink: 0 },
  centeredComposerSurface: { width: "100%", flexShrink: 1 },
  setup: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  hiddenSetup: { display: "none" },
});

// The fullscreen composer paints its own surface, including under the safe areas.
const themedStyles = ThemedStyleSheet.create((theme) => ({
  fullscreenComposer: { flex: 1, backgroundColor: theme.colors.surface1 },
}));
