import { codegenNativeComponent, type CodegenTypes, type ViewProps } from "react-native";

interface NativeProps extends ViewProps {
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
}

export default codegenNativeComponent<NativeProps>("PaseoInlineHeader");
