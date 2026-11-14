import { createContext } from "react";

export interface ComposerDockContentInsets {
  paddingLeft: number;
  paddingRight: number;
}

export const ComposerDockContentInsetsContext = createContext<ComposerDockContentInsets>({
  paddingLeft: 0,
  paddingRight: 0,
});
