import { forwardRef } from "react";
import { Text, View, type TextProps, type ViewProps } from "react-native";

export const WindowLayoutGeometryView = forwardRef<View, ViewProps>(
  function WindowLayoutGeometryView(props, ref) {
    return <View {...props} ref={ref} />;
  },
);

export const WindowLayoutGeometryText = forwardRef<Text, TextProps>(
  function WindowLayoutGeometryText(props, ref) {
    return <Text {...props} ref={ref} />;
  },
);
