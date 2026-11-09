import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { HEADER_INNER_HEIGHT_MOBILE, HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { bySizing, TOUCH_TARGET } from "@/components/ui/control-geometry";

const ThemedArrowLeft = withUnistyles(ArrowLeft);

const NO_SHORTCUT: ShortcutKey[] = [];

interface CompactHeaderProps {
  /** The leading island: the sidebar menu, or a back button. */
  navigation: "menu" | "back";
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
  /** Match the workspace's single-row touch header. */
  workspaceRow?: boolean;
}

/**
 * The phone header: the navigation button and the screen's actions sit in islands, with the title
 * left-aligned between them. Neither the header nor its islands draw a background, so it reads the
 * same in flow and floating over content (see `FloatingHeaderLayout`, whose fade gives the icons
 * contrast). Its height matches the old flat header, so anything
 * offset by the header height still lines up.
 */
export function CompactHeader({
  navigation,
  onBack,
  title,
  titleTestID,
  subtitle,
  loading = false,
  actions,
  workspaceRow = false,
}: CompactHeaderProps) {
  const insets = useSafeAreaInsets();
  const rootStyle = useMemo(
    () => [
      styles.root,
      {
        paddingTop: insets.top + (workspaceRow ? 0 : HEADER_TOP_PADDING_MOBILE),
        marginLeft: insets.left,
        marginRight: insets.right,
      },
    ],
    [insets.top, insets.left, insets.right, workspaceRow],
  );

  return (
    <IconButtonChromeProvider value="header-island">
      <View style={rootStyle}>
        <View style={[styles.row, workspaceRow && styles.workspaceRow]}>
          <View style={styles.island}>
            {navigation === "menu" ? <SidebarMenuToggle /> : <BackButton onBack={onBack} />}
          </View>
          <View style={styles.titleGroup}>
            <CompactHeaderTitle
              loading={loading}
              title={title}
              titleTestID={titleTestID}
              subtitle={subtitle}
              workspaceRow={workspaceRow}
            />
          </View>
          {actions ? <View style={styles.island}>{actions}</View> : null}
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
  workspaceRow = false,
}: Pick<CompactHeaderProps, "title" | "titleTestID" | "subtitle" | "workspaceRow"> & {
  loading: boolean;
  fadeOverflow?: boolean;
}) {
  if (loading) {
    return <View style={styles.titleSkeleton} />;
  }
  if (!title) {
    return subtitle ?? null;
  }
  const titleStyle = [
    subtitle ? styles.title : styles.singleLineTitle,
    workspaceRow && styles.workspaceTitle,
  ];
  return (
    <>
      {fadeOverflow ? (
        <FadingHeaderTitle title={title} titleTestID={titleTestID} style={titleStyle} />
      ) : (
        <Text style={titleStyle} numberOfLines={1} testID={titleTestID}>
          {title}
        </Text>
      )}
      {subtitle}
    </>
  );
}

interface FadingHeaderTitleProps {
  title: string;
  titleTestID?: string;
  style: StyleProp<TextStyle>;
}

function FadingHeaderTitle({ title, titleTestID, style }: FadingHeaderTitleProps) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(event.nativeEvent.layout.width);
  }, []);
  const measureText = useCallback((event: LayoutChangeEvent) => {
    setTextWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <View
      style={[styles.fadingTitle, inlineUnistylesStyle({ width: textWidth })]}
      onLayout={measureViewport}
    >
      {/* Horizontal content measures the full line; an ordinary Text reports its clipped width. */}
      <ScrollView
        horizontal
        scrollEnabled={false}
        style={styles.fadingTitleScroll}
        showsHorizontalScrollIndicator={false}
      >
        <Text
          style={[style, styles.unconstrainedTitle]}
          numberOfLines={1}
          ellipsizeMode="clip"
          testID={titleTestID}
          onLayout={measureText}
        >
          {title}
        </Text>
      </ScrollView>
      {textWidth > viewportWidth + 1 ? (
        <TrailingActionScrim backdrop="surface0" width={32} />
      ) : null}
    </View>
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
    paddingHorizontal: theme.spacing[3],
  },
  workspaceRow: {
    height: bySizing({ touch: TOUCH_TARGET, pointer: HEADER_INNER_HEIGHT_MOBILE }),
  },
  row: {
    height: HEADER_INNER_HEIGHT_MOBILE,
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
  workspaceTitle: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.25,
  },
  // A title without a subtitle has the header to itself, so it reads one step larger.
  singleLineTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  fadingTitle: {
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
  },
  fadingTitleScroll: {
    flexGrow: 0,
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
