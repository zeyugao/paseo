import { useContext, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useWindowLayout } from "@/window-layout";
import { resolveWorkspaceTopChromeInsets } from "@/window-layout/model";
import { WindowLayoutContentEdgesContext } from "@/window-layout/context";

/** The title and tab rows share one placement and one system-control clearance. */
export function WorkspaceTopChrome({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const layout = useWindowLayout();
  const edges = useContext(WindowLayoutContentEdgesContext);
  const chromeInsets = resolveWorkspaceTopChromeInsets(layout, insets, edges);
  const sharesTopBand = chromeInsets !== null;
  const headerInsets = useMemo(
    () => (sharesTopBand ? { ...insets, top: 0 } : insets),
    [insets, sharesTopBand],
  );
  return (
    <View style={chromeInsets} testID="workspace-top-chrome">
      <SafeAreaInsetsContext.Provider value={headerInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
