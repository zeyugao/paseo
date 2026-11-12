import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { WindowChromeSafeArea } from "@/utils/desktop-window";

export function ExplorerRailChrome({ children }: { children: ReactNode }) {
  return (
    <WindowChromeSafeArea placement="inline" style={styles.row}>
      {children}
    </WindowChromeSafeArea>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
});
