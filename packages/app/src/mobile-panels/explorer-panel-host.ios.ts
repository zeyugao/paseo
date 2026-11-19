import { codegenNativeComponent, type CodegenTypes, type ViewProps } from "react-native";

interface NativeProps extends ViewProps {
  requestedDockWidth?: CodegenTypes.Float;
  minimumDockWidth?: CodegenTypes.Float;
  minimumWorkspaceWidth?: CodegenTypes.Float;
}

export default codegenNativeComponent<NativeProps>("PaseoExplorerPanel");
