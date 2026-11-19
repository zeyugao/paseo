import { use } from "react";
import { SafeAreaFrameContext } from "react-native-safe-area-context";
import { AppWindowFrameContext } from "./app-window-frame-context";

// Once the probe owns geometry, a safe-area frame change must not trigger an
// earlier render with the previous probe snapshot.
export function useAppWindowSize() {
  const frame = use(AppWindowFrameContext);
  if (frame) return frame;
  const safeAreaFrame = use(SafeAreaFrameContext);
  if (!safeAreaFrame) {
    throw new Error("No safe area frame value available. Render SafeAreaProvider at the app root.");
  }
  return safeAreaFrame;
}

export function useAppWindowIsLandscape() {
  const frame = useAppWindowSize();
  return frame.width > frame.height;
}
