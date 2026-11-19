import { useCallback, useMemo, type ReactNode, type Ref } from "react";
import { Platform, View, type ViewProps, type ViewStyle } from "react-native";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ComposerFullscreenBody, ComposerFullscreenFooter } from "@/composer/dock";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isWeb } from "@/constants/platform";
import {
  iconSizeFor,
  TOOLBAR_CONTROL_HEIGHT,
  TOOLBAR_CONTROL_SIZES,
  type ControlSizing,
} from "@/components/ui/control-geometry";
import { StyleSheet } from "react-native-unistyles";
import { useComposerFullscreenExit } from "./fullscreen-exit";
import { ComposerSurfaceFrame } from "./surface-frame";
import type { ComposerSurfaceFrameProps } from "./surface-frame.types";
import { resolveGlyphRailOffset } from "./state";
import { WindowLayoutVariantView, type WindowLayoutVariants } from "@/window-layout/variant-view";

function keepEditorFocused(event: import("react-native").PointerEvent) {
  if (isWeb) event.preventDefault();
}

function ComposerFullscreenEnter({
  label,
  glyphSize,
  railOffset,
  collapsed,
  collapseInLandscape,
  onPress,
}: {
  label: string;
  glyphSize: number;
  railOffset: number;
  collapsed: boolean;
  collapseInLandscape: boolean;
  onPress: () => void;
}) {
  const nativeLayout = Platform.OS === "ios";
  const icon = useCallback(
    (color: string) => <Maximize2 color={color} size={glyphSize} />,
    [glyphSize],
  );
  // Fullscreen controls share the text rail; the toolbar disc owns its separate corner inset.
  const position = useMemo(() => ({ right: railOffset }), [railOffset]);
  if (!nativeLayout && collapsed) return null;
  const button = (
    <Button
      variant="ghost"
      size="sm"
      accessibilityLabel={label}
      leftIcon={icon}
      onPointerDown={keepEditorFocused}
      onPress={onPress}
      style={[styles.enterButton, position]}
      hitSlop={8}
    >
      {null}
    </Button>
  );
  if (!nativeLayout) return button;
  return (
    <WindowLayoutVariantView
      style={styles.enterSlot}
      variants={EXPANDED_CONTROL_LAYOUT}
      collapsed={collapsed}
      collapseInLandscape={collapseInLandscape}
      pointerEvents="box-none"
    >
      {button}
    </WindowLayoutVariantView>
  );
}

/**
 * One tree for both layout modes. The editing surface keeps its position so the
 * mounted editor, its native buffer, selection, and focus survive every toggle;
 * only the chrome around it changes. Fullscreen keeps the exit glyph on the text
 * rail and Send at the bottom right; a send error sits
 * in the same footer as Send.
 */
export function ComposerInputPresentation({
  fullscreen,
  collapsed = false,
  collapseInLandscape,
  layoutTransition,
  isCompact,
  readOnly,
  opacity,
  attachmentControl,
  attachmentControlLayout,
  attachmentControlWidth,
  controlSizing,
  surface,
  toolbar,
  send,
  error,
  onExit,
  onFocusInput,
  inputWrapperRef,
  inputWrapperStyle,
  inputPointerEvents,
  attachmentSlot,
  showFullscreenButton,
  onEnter,
  overlay,
}: {
  fullscreen: boolean;
  collapsed?: boolean;
  collapseInLandscape: boolean;
  layoutTransition?: ComposerSurfaceFrameProps["layoutTransition"];
  isCompact: boolean;
  readOnly: boolean;
  opacity: number;
  attachmentControl: ReactNode;
  attachmentControlLayout: WindowLayoutVariants;
  attachmentControlWidth: number;
  /** The sizing the toolbar's stylesheet resolves to; see `resolveControlSizing`. */
  controlSizing: ControlSizing;
  surface: ReactNode;
  toolbar: ReactNode;
  send: ReactNode;
  error: ReactNode;
  onExit: () => void;
  onFocusInput?: () => void;
  inputWrapperRef: Ref<View>;
  inputWrapperStyle?: ViewStyle;
  inputPointerEvents: ViewProps["pointerEvents"];
  attachmentSlot: ReactNode;
  showFullscreenButton: boolean;
  onEnter: () => void;
  overlay: ReactNode;
}) {
  const { t } = useTranslation();
  // A retained tab keeps its fullscreen editor mounted while hidden; the global exit
  // action (Escape, hardware back) belongs only to the pane the user is in.
  const { isActiveComposer } = useComposerKeyboardScope();
  const exitScopeRef = useComposerFullscreenExit(fullscreen && isActiveComposer, onExit);
  const glyphSize = iconSizeFor("md")[controlSizing];
  const railOffset = resolveGlyphRailOffset({
    controlSize: TOOLBAR_CONTROL_SIZES[controlSizing],
    glyphIconSize: glyphSize,
  });
  const minimizeIcon = useCallback(
    (color: string) => <Minimize2 color={color} size={glyphSize} />,
    [glyphSize],
  );
  const exitStyle = useMemo(() => [styles.iconButton, { marginRight: railOffset }], [railOffset]);
  const focusSurface = useMemo(
    () => (
      <PressHighlight
        style={styles.focusSurface}
        accessible={false}
        focusable={false}
        disabled={!onFocusInput}
        onPress={onFocusInput}
      />
    ),
    [onFocusInput],
  );
  const textLayout = useMemo<WindowLayoutVariants>(
    () => ({
      expanded: fullscreen
        ? { flex: 1 }
        : { paddingRight: Platform.OS === "ios" && isCompact ? 36 : undefined },
      collapsed: {
        flex: 1,
        minWidth: 0,
        marginLeft: attachmentControlWidth > 0 ? attachmentControlWidth + 8 : undefined,
      },
    }),
    [attachmentControlWidth, fullscreen, isCompact],
  );
  return (
    <View
      ref={exitScopeRef}
      style={fullscreen ? styles.fullscreen : styles.inline}
      testID={fullscreen ? "composer-fullscreen" : undefined}
    >
      {fullscreen ? (
        <View style={styles.exitRow}>
          <Button
            variant="ghost"
            size="sm"
            accessibilityLabel={t("composer.input.exitFullscreen")}
            onPointerDown={keepEditorFocused}
            onPress={onExit}
            style={exitStyle}
            leftIcon={minimizeIcon}
            hitSlop={8}
          >
            {null}
          </Button>
        </View>
      ) : null}
      <ComposerFullscreenBody fullscreen={fullscreen}>
        <ComposerSurfaceFrame
          inputWrapperRef={inputWrapperRef}
          style={inputWrapperStyle}
          pointerEvents={inputPointerEvents}
          fullscreen={fullscreen}
          collapsed={collapsed}
          collapseInLandscape={collapseInLandscape}
          layoutTransition={layoutTransition}
          isCompact={isCompact}
          readOnly={readOnly}
          opacity={opacity}
          focusSurface={focusSurface}
        >
          {fullscreen ? null : attachmentSlot}
          <WindowLayoutVariantView
            style={[styles.editorRow, fullscreen && styles.fullscreenTextSurface]}
            variants={EDITOR_ROW_LAYOUT}
            collapsed={collapsed}
            collapseInLandscape={collapseInLandscape}
            pointerEvents="box-none"
          >
            <WindowLayoutVariantView
              style={fullscreen ? styles.fullscreenTextSurface : styles.inlineTextSurface}
              variants={textLayout}
              collapsed={collapsed}
              collapseInLandscape={collapseInLandscape}
              pointerEvents="box-none"
            >
              {surface}
              {showFullscreenButton && !fullscreen ? (
                <ComposerFullscreenEnter
                  label={t("composer.input.fullscreen")}
                  glyphSize={glyphSize}
                  railOffset={railOffset}
                  collapsed={collapsed}
                  collapseInLandscape={collapseInLandscape}
                  onPress={onEnter}
                />
              ) : null}
            </WindowLayoutVariantView>
            {!fullscreen && attachmentControlWidth > 0 ? (
              <WindowLayoutVariantView
                style={styles.attachmentControl}
                variants={attachmentControlLayout}
                collapsed={collapsed}
                collapseInLandscape={collapseInLandscape}
              >
                {attachmentControl}
              </WindowLayoutVariantView>
            ) : null}
            {fullscreen ? null : toolbar}
          </WindowLayoutVariantView>
        </ComposerSurfaceFrame>
      </ComposerFullscreenBody>
      {fullscreen ? (
        <ComposerFullscreenFooter style={styles.footer}>
          {error}
          <View style={styles.sendRow}>{send}</View>
        </ComposerFullscreenFooter>
      ) : null}
      {overlay}
    </View>
  );
}

const EDITOR_ROW_LAYOUT: WindowLayoutVariants = {
  expanded: { flexDirection: "column", alignItems: "stretch", gap: 12 },
  collapsed: { flexDirection: "row", alignItems: "center", gap: 8 },
};
const EXPANDED_CONTROL_LAYOUT: WindowLayoutVariants = {
  expanded: { display: "flex" },
  collapsed: { display: "none" },
};

const styles = StyleSheet.create((theme) => ({
  inline: { flexShrink: 1, position: "relative" },
  inlineTextSurface: { flexShrink: 1, position: "relative" },
  editorRow: { flexShrink: 1, gap: theme.spacing[3] },
  attachmentControl: { position: "absolute", justifyContent: "center" },
  focusSurface: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  iconButton: {
    width: TOOLBAR_CONTROL_HEIGHT,
    height: TOOLBAR_CONTROL_HEIGHT,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  enterSlot: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  enterButton: {
    position: "absolute",
    top: 0,
    width: TOOLBAR_CONTROL_HEIGHT,
    height: TOOLBAR_CONTROL_HEIGHT,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  fullscreen: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  fullscreenTextSurface: { flex: 1, minHeight: 0 },
  exitRow: { alignItems: "flex-end", flexShrink: 0 },
  // The send error rides the keyboard with Send; below the body it would sit behind it.
  footer: { flexShrink: 0, gap: theme.spacing[3] },
  sendRow: { alignItems: "flex-end" },
}));
