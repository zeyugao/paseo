import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";

export const UserMessageExpansionContext = createContext<UserMessageExpansion | null>(null);

/** One store per viewed agent; saved reading state seeds rows before their first layout. */
export function useAgentUserMessageExpansion(
  agentId: string,
  initial?: readonly string[],
): UserMessageExpansion {
  const [owner, setOwner] = useState(() => ({
    agentId,
    expansion: createUserMessageExpansion(initial),
  }));
  if (owner.agentId === agentId) return owner.expansion;
  const next = { agentId, expansion: createUserMessageExpansion(initial) };
  setOwner(next);
  return next.expansion;
}

/** Subscribes one message to its own expanded state. */
export function useUserMessageExpanded(itemId: string) {
  const expansion = useContext(UserMessageExpansionContext);
  if (!expansion) throw new Error("MessagePreview requires a UserMessageExpansionContext");
  const subscribe = useCallback(
    (listener: () => void) => expansion.subscribe(itemId, listener),
    [expansion, itemId],
  );
  const getSnapshot = useCallback(() => expansion.isExpanded(itemId), [expansion, itemId]);
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = useCallback(() => expansion.toggle(itemId), [expansion, itemId]);
  return { expanded, toggle };
}
