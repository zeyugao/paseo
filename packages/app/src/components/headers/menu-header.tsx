import type { ReactNode } from "react";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { CompactHeader } from "./compact-header";
import { useSidebarMenuInWindowBar } from "./sidebar-menu-toggle";
import { useIsCompactFormFactor } from "@/constants/layout";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
}

export function MenuHeader({ title, rightContent, borderless }: MenuHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  const navigationInBar = useSidebarMenuInWindowBar();
  if (isCompact) {
    return (
      <CompactHeader
        navigation={navigationInBar ? null : "menu"}
        title={title}
        actions={rightContent}
      />
    );
  }
  return (
    <ScreenHeader navigation="menu" right={rightContent} borderless={borderless}>
      {title && <ScreenTitle>{title}</ScreenTitle>}
    </ScreenHeader>
  );
}
