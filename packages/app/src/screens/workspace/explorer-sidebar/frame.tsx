import { useCallback } from "react";
import { Platform, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  FileExplorerCloseGestureContext,
  useCloseFileExplorerGesture,
} from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useExplorerGeometry } from "./geometry";
import type { ExplorerFrameProps } from "./frame-props";
import { useWindowLayoutHasTopChrome, WindowLayoutStatusBar } from "@/window-layout";

function ExplorerFrameBase({
  children,
  surfaceColor,
  presentation,
  isOpen,
  isWorkspaceActive,
  persistenceKey,
  containerWidth,
}: ExplorerFrameProps) {
  const overlay = presentation === "overlay";
  const settledOpen = useIsMobilePanelActive("file-explorer");
  const active = isWorkspaceActive && (overlay ? settledOpen : isOpen);
  const resizeEnabled = isWorkspaceActive && !overlay && isOpen;
  const hasTopChrome = useWindowLayoutHasTopChrome();
  const extendToTop = !overlay && hasTopChrome;
  const hidesSystemStatusBar = isOpen && extendToTop;
  const { gesture, gestureRef } = useCloseFileExplorerGesture(
    isWorkspaceActive && overlay && containerWidth > 0,
    containerWidth,
  );
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resize = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const onResize = useCallback(
    (width: number) => resize(persistenceKey, width),
    [persistenceKey, resize],
  );
  const geometry = useExplorerGeometry({
    width: resolveExplorerSidebarWidth({ requestedWidth: storedWidth, containerWidth }),
    containerWidth,
    overlay,
    extendToTop,
    resizeEnabled,
    onResize,
  });
  return (
    <RetainedPanelActivity active={active}>
      {isWorkspaceActive && Platform.OS === "ios" ? (
        <WindowLayoutStatusBar hidden={hidesSystemStatusBar} />
      ) : null}
      <FileExplorerCloseGestureContext value={gestureRef}>
        <MobilePanelOverlay
          panel="file-explorer"
          closeGesture={gesture}
          presentation={presentation}
          dockVisible={isOpen}
          frameStyle={geometry.frameStyle}
          overlayWidth={containerWidth}
          panelStyle={[{ backgroundColor: surfaceColor }, geometry.panelStyle]}
        >
          <View style={styles.content}>
            {resizeEnabled ? geometry.resizeHandle : null}
            {children}
          </View>
        </MobilePanelOverlay>
      </FileExplorerCloseGestureContext>
    </RetainedPanelActivity>
  );
}
export const ExplorerFrame = withUnistyles(ExplorerFrameBase, (theme) => ({
  surfaceColor: theme.colors.surfaceSidebar,
}));
const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } });
