import { codegenNativeComponent, type ViewProps } from "react-native";

interface NativeProps extends ViewProps {}

export default codegenNativeComponent<NativeProps>("PaseoWindowActionPlane");
