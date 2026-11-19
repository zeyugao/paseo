import { createContext, useContext } from "react";

/** The input owns layout while a settings surface temporarily borrows editor focus. */
export const ComposerControlInteractionContext = createContext<{
  collapsed: boolean;
  onOpen: () => void;
  onClose: () => void;
} | null>(null);

export function useComposerControlInteraction() {
  return useContext(ComposerControlInteractionContext);
}
