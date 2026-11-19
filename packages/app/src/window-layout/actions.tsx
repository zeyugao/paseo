import { useId, useLayoutEffect, type ReactNode } from "react";
import { PortalHost, usePortal } from "@gorhom/portal";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import { useWindowLayout } from "./context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolveSidebarNavigationPlacement, resolveWorkspaceActionPlacement } from "./model";
import { WindowLayoutVariantView } from "./variant-view";

const HOST = "window-layout-actions";
const NAVIGATION_HOST = "window-layout-navigation";
const HEADER_ACTION_LAYOUT = {
  expanded: { display: "flex" },
  collapsed: { display: "none" },
} as const;

/** One frame owns the native guide; shell navigation precedes the active page's actions. */
export function WindowLayoutActionsHost() {
  const layout = useWindowLayout();
  const bar =
    resolveWorkspaceActionPlacement(layout) === "vertical-bar" ? layout?.verticalBar : null;
  // Keep both portal registries even while the guide is absent. Publishing a
  // new host when the guide arrives leaves the bar empty for another commit.
  const slots = (
    <>
      <PortalHost name={NAVIGATION_HOST} />
      <PortalHost name={HOST} />
    </>
  );
  const frame = bar && { left: bar.x, top: bar.y, width: bar.width, height: bar.height };
  if (Platform.OS === "ios") {
    return (
      <WindowLayoutVariantView
        testID="window-layout-bar"
        nativeID="paseo-window-bar"
        windowBarRole="host"
        collapsed={false}
        collapseInLandscape={false}
        style={[styles.bar, frame, !bar && styles.hidden]}
        pointerEvents="box-none"
      >
        {slots}
      </WindowLayoutVariantView>
    );
  }
  return (
    <View
      testID={bar ? "window-layout-bar" : undefined}
      style={bar ? [styles.bar, frame] : styles.hidden}
      pointerEvents="box-none"
    >
      {slots}
    </View>
  );
}

/** The header and the bar have complementary visibility in the native layout candidate. */
export function WindowLayoutHeaderActions({
  children,
  style,
  nativeID,
}: Pick<ViewProps, "children" | "style" | "nativeID">) {
  const inBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  if (Platform.OS !== "ios") return inBar ? null : <View style={style}>{children}</View>;
  return (
    <WindowLayoutVariantView
      nativeID={nativeID}
      windowBarRole="header-actions"
      collapsed={inBar}
      collapseInLandscape={false}
      variants={HEADER_ACTION_LAYOUT}
      style={style}
    >
      <RetainedPanelActivity active={!inBar}>{children}</RetainedPanelActivity>
    </WindowLayoutVariantView>
  );
}

/** The native bar guide is in window coordinates, so the host lives at the window root. */
export function WindowLayoutActions({
  children,
  active,
  slot = "content",
  followHeaderNavigation = false,
}: {
  children: ReactNode;
  active: boolean;
  slot?: "navigation" | "content";
  followHeaderNavigation?: boolean;
}) {
  const id = useId();
  const { addPortal, removePortal } = usePortal(slot === "navigation" ? NAVIGATION_HOST : HOST);
  useLayoutEffect(() => () => removePortal(id), [id, removePortal]);
  useLayoutEffect(() => {
    addPortal(
      id,
      <WindowBarActionGroup
        key={id}
        active={active}
        followHeaderNavigation={followHeaderNavigation}
      >
        {children}
      </WindowBarActionGroup>,
    );
  }, [active, addPortal, children, followHeaderNavigation, id]);
  return null;
}

function WindowBarActionGroup({
  active,
  children,
  followHeaderNavigation,
}: {
  active: boolean;
  children: ReactNode;
  followHeaderNavigation: boolean;
}) {
  const layout = useWindowLayout();
  const compact = useIsCompactFormFactor();
  const workspacePlacement = resolveWorkspaceActionPlacement(layout);
  const placement = followHeaderNavigation
    ? resolveSidebarNavigationPlacement(layout, compact)
    : workspacePlacement;
  const inBar = placement === "vertical-bar";
  if (Platform.OS === "ios" ? !active : workspacePlacement !== "vertical-bar") {
    return null;
  }
  const contents = (
    <RetainedPanelActivity active={active && inBar}>
      <IconButtonChromeProvider value="header-island">{children}</IconButtonChromeProvider>
    </RetainedPanelActivity>
  );
  if (Platform.OS === "ios" && followHeaderNavigation) {
    return (
      <WindowLayoutVariantView
        windowBarRole="bar-navigation"
        collapsed={!inBar}
        collapseInLandscape={false}
        variants={HEADER_ACTION_LAYOUT}
        testID="workspace-vertical-actions"
        nativeID="paseo-window-bar-navigation"
        style={styles.actions}
        pointerEvents="box-none"
      >
        {contents}
      </WindowLayoutVariantView>
    );
  }
  return (
    <View
      testID="workspace-vertical-actions"
      style={[styles.actions, !active && styles.hidden]}
      pointerEvents="box-none"
    >
      {contents}
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
  actions: { alignItems: "center", gap: 8 },
  bar: { position: "absolute", alignItems: "center", gap: 8 },
});
