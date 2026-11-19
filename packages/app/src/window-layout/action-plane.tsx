import type { ReactNode } from "react";
import { WindowLayoutActions } from "./actions";

export function WindowActionPlane({ children }: { children: ReactNode }) {
  return children;
}

export function InlineWindowActions({
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return <WindowLayoutActions active={active}>{children}</WindowLayoutActions>;
}
