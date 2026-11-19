import { Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";

// Keep this module outside the Unistyles Babel root. Native style-family updates
// can replay pending React geometry onto the committed tree. Resolve theme styles
// through React without registering another native writer for these hosts.
export const WindowLayoutGeometryView = withUnistyles(View);
export const WindowLayoutGeometryText = withUnistyles(Text);
