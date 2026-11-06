import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttentionBucket } from "@/utils/attention-indicator";
import { getStatusDotColor } from "@/utils/status-dot-color";

export function HeaderAttentionDot({
  bucket,
  testID,
}: {
  bucket: AttentionBucket | null;
  testID?: string;
}) {
  if (!bucket) return null;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.dot(bucket)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: (bucket: AttentionBucket) => ({
    position: "absolute",
    top: -2,
    right: -3,
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
  }),
}));
