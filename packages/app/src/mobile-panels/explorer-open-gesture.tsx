import { type ReactNode, useCallback } from "react";
import { View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { useOpenFileExplorerGesture } from "@/mobile-panels/gestures";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { showExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { isWeb } from "@/constants/platform";

interface CompactExplorerOpenGestureSurfaceProps {
  children: ReactNode;
  enabled: boolean;
  onOpenExplorer: () => void;
}

const COMPACT_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

function CompactExplorerOpenGestureSurface({
  children,
  enabled,
  onOpenExplorer,
}: CompactExplorerOpenGestureSurfaceProps) {
  const viewportWidth = useSharedValue(useWindowDimensions().width);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.value = event.nativeEvent.layout.width;
    },
    [viewportWidth],
  );
  const explorerOpenGesture = useOpenFileExplorerGesture({
    enabled,
    onOpen: onOpenExplorer,
    viewportWidth,
  });

  return (
    <GestureDetector gesture={explorerOpenGesture} touchAction={COMPACT_WEB_GESTURE_TOUCH_ACTION}>
      <View style={styles.fill} onLayout={onLayout}>
        {children}
      </View>
    </GestureDetector>
  );
}

export function WorkspaceExplorerOpenGesture({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const selection = useActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const handleOpen = useCallback(() => {
    if (!selection || !workspace) return;
    showExplorerSidebar({
      isCompact: true,
      workspaceKey: `${selection.serverId}:${selection.workspaceId}`,
    });
  }, [selection, workspace]);
  return (
    <CompactExplorerOpenGestureSurface
      enabled={enabled && Boolean(workspace)}
      onOpenExplorer={handleOpen}
    >
      {children}
    </CompactExplorerOpenGestureSurface>
  );
}
const styles = { fill: { flex: 1 } };
