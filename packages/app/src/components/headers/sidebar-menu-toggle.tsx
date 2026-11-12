import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelLeft } from "lucide-react-native";
import { HeaderToggleButton, headerIconSlotStyle } from "./header-toggle-button";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useHasWindowChromeObstruction, useOwnsWindowChromeCorner } from "@/utils/desktop-window";
import { useSidebarAttention } from "@/hooks/use-sidebar-attention";
import { HeaderAttentionDot } from "./attention-dot";
import { ATTENTION_LABEL_KEYS } from "@/utils/attention-indicator";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { bySizing } from "@/components/ui/control-geometry";
import { resolveSidebarMenuTogglePresentation } from "@/components/desktop-sidebar-layout";

const ThemedPanelLeft = withUnistyles(PanelLeft);

interface SidebarMenuToggleProps {
  style?: StyleProp<ViewStyle>;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  testID?: string;
  nativeID?: string;
}

const MOBILE_MENU_LINE_WIDTH = 16;
const MOBILE_MENU_LINE_SHORT_WIDTH = 8;
const MOBILE_MENU_LINE_HEIGHT = 1.5;

function MobileMenuIcon({ extraMuted }: { extraMuted: boolean }) {
  const color = extraMuted ? styles.mobileMenuLineExtraMuted : styles.mobileMenuLineMuted;
  const lineStyle = useMemo(() => [styles.mobileMenuLine, color], [color]);
  const shortLineStyle = useMemo(
    () => [styles.mobileMenuLine, styles.mobileMenuLineShort, color],
    [color],
  );
  return (
    <View style={styles.mobileMenuIcon} pointerEvents="none">
      <View style={lineStyle} />
      <View style={lineStyle} />
      <View style={shortLineStyle} />
    </View>
  );
}

function SidebarMenuToggleButton({
  isMobile,
  extraMutedIdleIcon = false,
  resolvedStyle,
  tooltipSide = "right",
  testID = "menu-button",
  nativeID = "menu-button",
}: Omit<SidebarMenuToggleProps, "style"> & {
  isMobile: boolean;
  extraMutedIdleIcon?: boolean;
  resolvedStyle: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: isMobile }));
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const attentionBucket = useSidebarAttention(isOpen);
  const toggleShortcutKeys = useMemo(
    () => (getShortcutOs() === "mac" ? ["mod", "B"] : ["mod", "."]),
    [],
  );

  const handlePress = useCallback(() => {
    toggleAgentListForLayout({ isCompact: isMobile });
  }, [toggleAgentListForLayout, isMobile]);

  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);
  const attentionLabel = attentionBucket ? t(ATTENTION_LABEL_KEYS[attentionBucket]) : undefined;

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("shell.menu.toggleSidebar")}
      tooltipKeys={toggleShortcutKeys}
      tooltipSide={tooltipSide}
      testID={testID}
      nativeID={nativeID}
      style={resolvedStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={[isOpen ? t("shell.menu.close") : t("shell.menu.open"), attentionLabel]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={accessibilityState}
    >
      <View style={isMobile ? styles.mobileMenuIcon : styles.desktopAttentionGlyph}>
        {isMobile ? (
          <MobileMenuIcon extraMuted={extraMutedIdleIcon} />
        ) : (
          <ThemedPanelLeft
            size={iconButtonChromeGlyphSize("large")}
            strokeWidth={1.5}
            uniProps={extraMutedIdleIcon ? extraMutedIconColorMapping : mutedIconColorMapping}
          />
        )}
        <HeaderAttentionDot bucket={attentionBucket} testID="sidebar-toggle-attention" />
      </View>
    </HeaderToggleButton>
  );
}

export function SidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const isMobile = useIsCompactFormFactor();
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: isMobile }));
  const leftSidebarPresentation = usePanelStore((state) => state.layout.leftSidebar);
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  // The negative inset belongs to a docked navigation edge. An overlay leaves this header's
  // leading edge in place, so switching the inset would move the title before the panel covers it.
  const navigationBesideToggle = isOpen && leftSidebarPresentation === "dock";
  const resolvedStyle = useMemo(
    () => [styles.leadingToggle, !navigationBesideToggle && styles.collapsedLeadingToggle, style],
    [navigationBesideToggle, style],
  );
  const placeholderStyle = useMemo(
    () => [headerIconSlotStyle.slot, resolvedStyle],
    [resolvedStyle],
  );

  const presentation = resolveSidebarMenuTogglePresentation({
    isCompact: isMobile,
    ownsTopLeft,
    hasTopLeftWindowControls,
  });
  if (presentation === "hidden") return null;

  if (presentation === "placeholder") {
    return (
      <View pointerEvents="none" style={placeholderStyle}>
        <View style={styles.desktopMenuIconSpace} />
      </View>
    );
  }

  return <SidebarMenuToggleButton {...props} isMobile={isMobile} resolvedStyle={resolvedStyle} />;
}

export function WindowSidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  return (
    <SidebarMenuToggleButton
      {...props}
      isMobile={false}
      extraMutedIdleIcon
      resolvedStyle={resolvedStyle}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  leadingToggle: {
    marginLeft: {
      xs: 0,
      md: -theme.spacing[2],
    },
  },
  // Without navigation beside it, the touch control must clear the window's rounded corner.
  collapsedLeadingToggle: {
    marginLeft: bySizing({ touch: 0, pointer: -theme.spacing[2] }),
  },
  mobileMenuIcon: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: 12,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  desktopMenuIconSpace: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  desktopAttentionGlyph: {
    width: iconButtonChromeGlyphSize("large"),
    height: iconButtonChromeGlyphSize("large"),
  },
  mobileMenuLine: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: MOBILE_MENU_LINE_HEIGHT,
    borderRadius: theme.borderRadius.full,
  },
  mobileMenuLineMuted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  mobileMenuLineExtraMuted: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  mobileMenuLineShort: {
    width: MOBILE_MENU_LINE_SHORT_WIDTH,
  },
}));
