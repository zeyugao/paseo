import { createContext } from "react";

export interface ComposerDockContentInsets {
  paddingLeft: number;
  paddingRight: number;
  /** Space already consumed by the native parent, not padding to add to a child. */
  nativeHorizontalPadding?: number;
}

export const ComposerDockContentInsetsContext = createContext<ComposerDockContentInsets>({
  paddingLeft: 0,
  paddingRight: 0,
});

/** Allocated input width after the dock's horizontal insets, or null if self-sized. */
export const ComposerLayoutWidthContext = createContext<number | null>(null);
