import type { ComponentProps, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { MobilePanelOverlay } from "@/mobile-panels/presentation";
export interface ExplorerGeometryInput {
  workspaceKey: string;
  width: number;
  requestedWidth?: number;
  containerWidth: number;
  overlay: boolean;
  isOpen: boolean;
  resizeEnabled: boolean;
  onResize: (width: number) => void;
}
export interface ExplorerGeometry {
  frameStyle: ComponentProps<typeof MobilePanelOverlay>["frameStyle"];
  requestedDockWidth?: number;
  panelStyle: StyleProp<ViewStyle>;
  resizeHandle: ReactNode;
}
