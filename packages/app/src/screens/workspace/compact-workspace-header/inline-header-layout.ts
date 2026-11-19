import type { CodegenTypes, ViewProps } from "react-native";
import { WindowLayoutGeometryView } from "@/window-layout";

type NativeProps = ViewProps & {
  titleWidthCap?: CodegenTypes.Float;
  singleTitleFontSize?: CodegenTypes.Float;
  projectTitleFontSize?: CodegenTypes.Float;
  compactContentWidth?: CodegenTypes.Float;
  naturalRailWidth?: CodegenTypes.Float;
  scrollingFloor?: CodegenTypes.Float;
  navigationControlWidth?: CodegenTypes.Float;
  navigationGap?: CodegenTypes.Float;
  actionFrameWidth?: CodegenTypes.Float;
  actionGap?: CodegenTypes.Float;
  tabGap?: CodegenTypes.Float;
};

export default WindowLayoutGeometryView as React.ComponentType<NativeProps>;
