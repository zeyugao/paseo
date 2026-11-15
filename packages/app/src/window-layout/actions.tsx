import type { ReactNode } from "react";
import { Portal, PortalHost } from "@gorhom/portal";
import { StyleSheet, View } from "react-native";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement } from "./model";

const HOST = "window-layout-actions";
const NAVIGATION_HOST = "window-layout-navigation";

/** One frame owns the native guide; shell navigation precedes the active page's actions. */
export function WindowLayoutActionsHost() {
  const layout = useWindowLayout();
  const bar = layout?.verticalBar;
  if (resolveWorkspaceActionPlacement(layout) !== "vertical-bar" || !bar) return null;
  return (
    <View
      testID="window-layout-bar"
      style={[styles.bar, { left: bar.x, top: bar.y, width: bar.width, height: bar.height }]}
      pointerEvents="box-none"
    >
      <PortalHost name={NAVIGATION_HOST} />
      <PortalHost name={HOST} />
    </View>
  );
}

/** The native bar guide is in window coordinates, so the host lives at the window root. */
export function WindowLayoutActions({
  children,
  active,
  slot = "content",
}: {
  children: ReactNode;
  active: boolean;
  slot?: "navigation" | "content";
}) {
  const layout = useWindowLayout();
  if (resolveWorkspaceActionPlacement(layout) !== "vertical-bar" || !layout?.verticalBar) {
    return null;
  }
  return (
    <Portal hostName={slot === "navigation" ? NAVIGATION_HOST : HOST}>
      <View
        testID="workspace-vertical-actions"
        style={[styles.actions, !active && styles.hidden]}
        pointerEvents="box-none"
      >
        <RetainedPanelActivity active={active}>
          <IconButtonChromeProvider value="header-island">{children}</IconButtonChromeProvider>
        </RetainedPanelActivity>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
  actions: { alignItems: "center", gap: 8 },
  bar: { position: "absolute", alignItems: "center", gap: 8 },
});
