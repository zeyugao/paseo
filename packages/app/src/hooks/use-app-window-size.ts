import { useWindowDimensions } from "react-native";

export function useAppWindowSize() {
  return useWindowDimensions();
}

export function useAppWindowIsLandscape() {
  const { width, height } = useAppWindowSize();
  return width > height;
}
