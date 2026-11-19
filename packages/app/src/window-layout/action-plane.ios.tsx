import { PortalHost, usePortal } from "@gorhom/portal";
import { useLayoutEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import ActionPlane from "./action-plane-native.ios";

const HOST = "window-layout-inline-actions";

export function WindowActionPlane({ children }: { children: ReactNode }) {
  return (
    <ActionPlane style={styles.fill} pointerEvents="box-none">
      <View style={styles.fill} pointerEvents="box-none">
        {children}
      </View>
      <PortalHost name={HOST} />
    </ActionPlane>
  );
}

export function InlineWindowActions({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  const { addPortal, removePortal } = usePortal(HOST);
  useLayoutEffect(() => () => removePortal(id), [id, removePortal]);
  useLayoutEffect(() => {
    addPortal(
      id,
      <View
        key={id}
        nativeID={id}
        style={[styles.group, !active && styles.inactive]}
        pointerEvents="box-none"
      >
        <RetainedPanelActivity active={active}>
          <IconButtonChromeProvider value="header-island">{children}</IconButtonChromeProvider>
        </RetainedPanelActivity>
      </View>,
    );
  }, [active, addPortal, children, id]);
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  group: { position: "absolute", alignItems: "center", gap: 8 },
  inactive: { display: "none" },
});
