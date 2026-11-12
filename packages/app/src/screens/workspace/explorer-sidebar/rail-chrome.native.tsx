import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useWindowChromeInlinePadding } from "@/utils/desktop-window";
import { useWindowLayoutHasTopChrome } from "@/window-layout";

const RELEASE_TIMING = {
  duration: 180,
  easing: Easing.inOut(Easing.ease),
  reduceMotion: ReduceMotion.System,
};

export function ExplorerRailChrome({ children }: { children: ReactNode }) {
  const { paddingLeft, paddingRight } = useWindowChromeInlinePadding();
  const active = useRetainedPanelActive();
  const hasTopChrome = useWindowLayoutHasTopChrome();
  const trailingClearance = useSharedValue(paddingRight);

  useAnimatedReaction(
    () => ({ paddingRight, active, hasTopChrome }),
    (next) => {
      cancelAnimation(trailingClearance);
      // The target releases status clearance only after native hiding has completed.
      // Retaining more space during release is safe; new obstructions apply immediately.
      trailingClearance.value =
        next.active && next.hasTopChrome && next.paddingRight < trailingClearance.value
          ? withTiming(next.paddingRight, RELEASE_TIMING)
          : next.paddingRight;
    },
    [paddingRight, active, hasTopChrome],
  );
  const chromeStyle = useAnimatedStyle(() => ({
    paddingLeft,
    paddingRight: Math.max(paddingRight, trailingClearance.value),
  }));

  return <Animated.View style={[styles.row, chromeStyle]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  row: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
});
