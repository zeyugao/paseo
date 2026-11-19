// Browser ESM validates named imports before platform guards run. Keep native-only
// bindings available so importing shared components does not require their native branch.
export * from "react-native-web/dist/index.js";

export const ToastAndroid = {
  SHORT: 0,
  LONG: 1,
  TOP: 0,
  BOTTOM: 1,
  CENTER: 2,
  show() {},
  showWithGravity() {},
};

export const ActionSheetIOS = {
  showActionSheetWithOptions() {
    throw new Error("ActionSheetIOS cannot be used in browser tests");
  },
};
