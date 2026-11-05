import type { ReactNode } from "react";
import { StyleSheet } from "react-native-unistyles";
import { ScreenHeader } from "./screen-header";
import { ScreenTitle } from "./screen-title";
import { CompactHeader } from "./compact-header";
import { SidebarMenuToggle } from "./sidebar-menu-toggle";
import { useIsCompactFormFactor } from "@/constants/layout";
import { WindowTopChrome } from "@/window-layout/top-chrome";

interface MenuHeaderProps {
  title?: string;
  rightContent?: ReactNode;
  borderless?: boolean;
}

export function MenuHeader({ title, rightContent, borderless }: MenuHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) {
    return <CompactHeader navigation="menu" title={title} actions={rightContent} />;
  }
  return (
    <WindowTopChrome>
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            {title && <ScreenTitle>{title}</ScreenTitle>}
          </>
        }
        right={rightContent}
        leftStyle={styles.left}
        borderless={borderless}
      />
    </WindowTopChrome>
  );
}

const styles = StyleSheet.create((theme) => ({
  left: {
    gap: theme.spacing[2],
  },
}));
