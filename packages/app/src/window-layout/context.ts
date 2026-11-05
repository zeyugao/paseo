import { createContext, useContext } from "react";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import type { WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);
// Physical shell edges, independent of desktop window-control ownership.
export const WindowLayoutContentEdgesContext = createContext({ left: true, right: true });

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useAppWindowSize();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}
