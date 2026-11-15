import type { ReactElement, ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { bySizing, controlSizingForLayout } from "@/components/ui/control-geometry";
import { iconButtonChromeGlyphInset } from "@/components/ui/icon-button-chrome";
import { SidebarMenuToggle, useSidebarMenuTogglePresentation } from "./sidebar-menu-toggle";

const GUTTER = { touch: 16, pointer: 12 };
const GLYPH_INSET = {
  touch: iconButtonChromeGlyphInset("large", "touch"),
  pointer: iconButtonChromeGlyphInset("large", "pointer"),
};

export const HEADER_CONTENT_PADDING = bySizing(GUTTER);

export function headerContentPaddingForLayout(compact: boolean): number {
  return GUTTER[controlSizingForLayout(compact)];
}

export function headerNavigationGapForLayout(compact: boolean): number {
  const sizing = controlSizingForLayout(compact);
  return GUTTER[sizing] - GLYPH_INSET[sizing];
}

export type HeaderNavigation = "menu" | ReactElement | null;

/** Align the glyph, rather than its larger touch frame, to the header's content rail. */
export function HeaderLeading({
  navigation,
  navigationTestID,
  navigationNativeID,
  style,
  children,
}: {
  navigation: HeaderNavigation;
  navigationTestID?: string;
  navigationNativeID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const sidebarPresentation = useSidebarMenuTogglePresentation();
  let control = navigation;
  if (navigation === "menu") {
    control =
      sidebarPresentation === "hidden" ? null : (
        <SidebarMenuToggle testID={navigationTestID} nativeID={navigationNativeID} />
      );
  }
  return (
    <View style={[styles.row, style]}>
      {control ? <View style={styles.navigation}>{control}</View> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: bySizing({
      touch: GUTTER.touch - GLYPH_INSET.touch,
      pointer: GUTTER.pointer - GLYPH_INSET.pointer,
    }),
  },
  navigation: {
    flexShrink: 0,
    marginLeft: bySizing({ touch: -GLYPH_INSET.touch, pointer: -GLYPH_INSET.pointer }),
  },
});
