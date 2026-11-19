import { createContext } from "react";

// The native list invalidates mounted measurements when the window or its local allocation changes.
export const StreamViewportLayoutContext = createContext<{
  active: boolean;
  windowWidth: number;
  windowHeight: number;
  windowClearance: number;
  paneWidth: number | null;
  listWidth: number;
} | null>(null);
