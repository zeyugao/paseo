import { ComposerDockBackground } from "@/composer/dock";
import { useMemo, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HeaderTopInset } from "./header-top-inset";
import {
  HeaderLeading,
  headerContentPaddingForLayout,
  type HeaderNavigation,
} from "./header-leading";

interface ScreenHeaderProps {
  children?: ReactNode;
  navigation?: HeaderNavigation;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  children,
  navigation,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const isMobile = useIsCompactFormFactor();
  // Compact headers add vertical breathing room; horizontal rails follow input sizing.
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const baseHorizontalPadding = headerContentPaddingForLayout(isMobile);

  const rowStyle = useMemo(() => [styles.row, borderless && styles.borderless], [borderless]);
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  const rightCombinedStyle = useMemo(() => [styles.right, rightStyle], [rightStyle]);

  return (
    <ComposerDockBackground style={styles.header} testID="composer-dock-header">
      <HeaderTopInset additionalPadding={topPadding} />
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={baseHorizontalPadding}
        onLayout={onRowLayout}
        style={rowStyle}
      >
        <TitlebarDragRegion />
        <View style={leftCombinedStyle}>
          {navigation === undefined ? (
            children
          ) : (
            <HeaderLeading navigation={navigation}>{children}</HeaderLeading>
          )}
        </View>
        <View style={rightCombinedStyle}>{right}</View>
      </WindowChromeSafeArea>
    </ComposerDockBackground>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
}));
