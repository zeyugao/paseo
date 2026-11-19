import { createContext, useContext, type ReactNode } from "react";
import { WindowLayoutTopInset } from "@/window-layout";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";

const HeaderTopInsetOwnedContext = createContext(false);

/**
 * Standalone navigation headers keep the workspace's landscape breathing room even when the
 * portrait compact branch (and its `additionalPadding`) no longer applies at the wider bound.
 * An owning `HeaderTopInsetHost` stays the single consumer inside workspace chrome.
 */
export function HeaderTopInset({ additionalPadding = 0 }: { additionalPadding?: number }) {
  const owned = useContext(HeaderTopInsetOwnedContext);
  return owned ? null : (
    <WindowLayoutTopInset
      additionalPadding={additionalPadding}
      landscapePadding={HEADER_TOP_PADDING_MOBILE}
    />
  );
}

/** Keep native clearance mounted while the header below it changes presentation. */
export function HeaderTopInsetHost({
  active,
  additionalPadding,
  children,
}: {
  active: boolean;
  additionalPadding: number;
  children: ReactNode;
}) {
  return (
    <HeaderTopInsetOwnedContext.Provider value={active}>
      {active ? (
        <WindowLayoutTopInset
          additionalPadding={additionalPadding}
          landscapePadding={HEADER_TOP_PADDING_MOBILE}
        />
      ) : null}
      {children}
    </HeaderTopInsetOwnedContext.Provider>
  );
}
