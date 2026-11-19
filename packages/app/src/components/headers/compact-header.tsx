import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type TextProps,
} from "react-native";
import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { HeaderLeading, HEADER_CONTENT_PADDING } from "./header-leading";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { useTopBand, WindowLayoutGeometryView, WindowLayoutGeometryText } from "@/window-layout";
import { WindowLayoutHeaderActions } from "@/window-layout/actions";
import { HeaderTopInset } from "./header-top-inset";

const ThemedArrowLeft = withUnistyles(ArrowLeft);

const NO_SHORTCUT: ShortcutKey[] = [];

interface CompactHeaderProps {
  /** The leading island, or null when navigation is hosted in the window bar. */
  navigation: "menu" | "back" | null;
  /** Back button action. Defaults to navigating back. */
  onBack?: () => void;
  title?: string;
  titleTestID?: string;
  /** A line under the title. */
  subtitle?: ReactNode;
  /** Show a placeholder instead of the title while it loads. */
  loading?: boolean;
  /** Icon actions inherit the island chrome through the shared button primitives. */
  actions?: ReactNode;
  actionsFollowWindowBar?: boolean;
}

/**
 * The phone header: the navigation button and the screen's actions sit in islands, with the title
 * left-aligned between them. Neither the header nor its islands draw a background, so it reads the
 * same in flow and floating over content (see `FloatingHeaderLayout`, whose fade gives the icons
 * contrast). Its height matches the old flat header, so anything
 * offset by the header height still lines up. In a window's top band it takes the top bar's
 * place, like the full header. The column hosting it reserves any window-chrome corner it owns.
 */
export function CompactHeader({
  navigation,
  onBack,
  title,
  titleTestID,
  subtitle,
  loading = false,
  actions,
  actionsFollowWindowBar = false,
}: CompactHeaderProps) {
  const insets = useSafeAreaInsets();
  const inTopBand = useTopBand() !== null;
  const rootStyle = useMemo(
    () => [
      styles.root,
      {
        marginLeft: insets.left,
        marginRight: insets.right,
      },
    ],
    [insets.left, insets.right],
  );
  const leadingNavigation = useMemo(
    () => (navigation === "back" ? <BackButton onBack={onBack} /> : navigation),
    [navigation, onBack],
  );
  const ActionSlot = actionsFollowWindowBar ? WindowLayoutHeaderActions : View;

  return (
    <IconButtonChromeProvider value="header-island">
      <View style={rootStyle}>
        <HeaderTopInset additionalPadding={HEADER_TOP_PADDING_MOBILE} />
        <View style={inTopBand ? styles.topBandRow : styles.row}>
          <HeaderLeading navigation={leadingNavigation}>
            <View style={styles.titleGroup}>
              <CompactHeaderTitle
                loading={loading}
                title={title}
                titleTestID={titleTestID}
                subtitle={subtitle}
              />
            </View>
          </HeaderLeading>
          {actions ? <ActionSlot style={styles.island}>{actions}</ActionSlot> : null}
        </View>
      </View>
    </IconButtonChromeProvider>
  );
}

export function CompactHeaderTitle({
  loading,
  title,
  titleTestID,
  subtitle,
  fadeOverflow = false,
  overflow,
  onTitleTextLayout,
  retainProject = false,
}: Pick<CompactHeaderProps, "title" | "titleTestID" | "subtitle"> & {
  loading: boolean;
  fadeOverflow?: boolean;
  overflow?: boolean;
  onTitleTextLayout?: TextProps["onTextLayout"];
  retainProject?: boolean;
}) {
  if (loading) {
    return <View style={styles.titleSkeleton} />;
  }
  const project = retainProject ? (
    <WindowLayoutGeometryView
      nativeID="paseo-inline-project"
      accessibilityElementsHidden
      style={styles.retainedProjectViewport}
    >
      <View nativeID="paseo-inline-project-content" style={styles.retainedProjectContent}>
        {subtitle}
      </View>
    </WindowLayoutGeometryView>
  ) : (
    subtitle
  );
  if (!title) {
    return project ?? null;
  }
  const titleStyle = subtitle && !retainProject ? styles.title : styles.singleLineTitle;
  return (
    <>
      {fadeOverflow ? (
        <FadingHeaderTitle
          title={title}
          titleTestID={titleTestID}
          style={titleStyle}
          overflow={overflow}
          onTextLayout={onTitleTextLayout}
          nativeAllocation={retainProject}
        />
      ) : (
        <WindowLayoutGeometryText
          style={titleStyle}
          numberOfLines={1}
          testID={titleTestID}
          onTextLayout={onTitleTextLayout}
        >
          {title}
        </WindowLayoutGeometryText>
      )}
      {project}
    </>
  );
}

interface FadingHeaderTitleProps {
  title: string;
  titleTestID?: string;
  style: StyleProp<TextStyle>;
  overflow?: boolean;
  onTextLayout?: TextProps["onTextLayout"];
  nativeAllocation: boolean;
}

function FadingHeaderTitle({
  title,
  titleTestID,
  style,
  overflow,
  onTextLayout,
  nativeAllocation,
}: FadingHeaderTitleProps) {
  const needsMeasurement = !nativeAllocation && overflow === undefined;
  const [viewportWidth, setViewportWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(event.nativeEvent.layout.width);
  }, []);
  const measureText = useCallback((event: LayoutChangeEvent) => {
    setTextWidth(event.nativeEvent.layout.width);
  }, []);

  const content = (
    <>
      <WindowLayoutGeometryText
        style={[style, styles.clippedTitle]}
        nativeID={nativeAllocation ? "paseo-inline-title-glyphs" : undefined}
        numberOfLines={1}
        ellipsizeMode="clip"
        testID={titleTestID}
        onTextLayout={onTextLayout}
      >
        {title}
      </WindowLayoutGeometryText>
      {/* Only cold, unallocated titles need a local measurement round trip. */}
      {needsMeasurement ? (
        <ScrollView
          horizontal
          scrollEnabled={false}
          style={styles.titleMeasurement}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          showsHorizontalScrollIndicator={false}
        >
          <WindowLayoutGeometryText
            style={[style, styles.unconstrainedTitle]}
            numberOfLines={1}
            onLayout={measureText}
          >
            {title}
          </WindowLayoutGeometryText>
        </ScrollView>
      ) : null}
      {nativeAllocation || (overflow ?? textWidth > viewportWidth + 1) ? (
        <TrailingActionScrim
          backdrop="surface0"
          width={32}
          nativeID={nativeAllocation ? "paseo-inline-title-scrim" : undefined}
          testID={titleTestID ? `${titleTestID}-fade` : undefined}
        />
      ) : null}
    </>
  );
  const onLayout = needsMeasurement ? measureViewport : undefined;
  return (
    <WindowLayoutGeometryView style={styles.fadingTitle} onLayout={onLayout}>
      {content}
    </WindowLayoutGeometryView>
  );
}

function BackButton({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    router.back();
  }, [onBack]);
  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("common.actions.back")}
      tooltipKeys={NO_SHORTCUT}
      tooltipSide="right"
      testID="header-back-button"
      accessibilityRole="button"
      accessibilityLabel={t("common.actions.back")}
    >
      <ThemedArrowLeft
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={mutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingHorizontal: HEADER_CONTENT_PADDING,
  },
  row: {
    height: HEADER_INNER_HEIGHT_MOBILE,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  topBandRow: {
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    // Both title lines receive the remaining width; text alignment does not size the slot.
    alignItems: "stretch",
  },
  island: {
    flexDirection: "row",
    alignItems: "center",
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  // A title without a subtitle has the header to itself, so it reads one step larger.
  singleLineTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  // The row keeps its intrinsic height even when its layout slot closes.
  // UIKit can interpolate the slot's bounds without mounting a new paragraph.
  retainedProjectViewport: {
    overflow: "hidden",
    maxHeight: 0,
  },
  retainedProjectContent: {
    flexShrink: 0,
  },
  fadingTitle: {
    width: "100%",
    flexDirection: "row",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
  },
  clippedTitle: {
    width: "100%",
    flexShrink: 1,
  },
  titleMeasurement: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0,
  },
  unconstrainedTitle: {
    flexShrink: 0,
  },
  titleSkeleton: {
    width: 140,
    maxWidth: "100%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
}));
