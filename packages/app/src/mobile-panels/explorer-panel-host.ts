import type { ComponentProps, ComponentType } from "react";
import Animated from "react-native-reanimated";

type ExplorerPanelHostProps = ComponentProps<typeof Animated.View> & {
  requestedDockWidth?: number;
  minimumDockWidth?: number;
  minimumWorkspaceWidth?: number;
};

const ExplorerPanelHost: ComponentType<ExplorerPanelHostProps> = Animated.View;
export default ExplorerPanelHost;
