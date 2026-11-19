import { useCallback, useContext, useState, type ReactNode } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isPortraitWorkspaceWindow, selectWorkspaceChrome } from "./workspace-tab-layout";
import {
  WorkspaceTabMeasurementScope,
  type WorkspaceTabMeasurementInput,
} from "./workspace-desktop-tabs-row";
import { WorkspaceHeaderTitleMeasurementScope } from "./compact-workspace-header";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import { WorkspaceHeaderWidthContext } from "./use-workspace-header-width";
import { HeaderTopInsetHost } from "@/components/headers/header-top-inset";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { useWindowLayout } from "@/window-layout";
import { WindowLayoutPaneWidthContext } from "@/window-layout/context";
import { WindowChromeProvider, useWindowChromeCorners } from "@/utils/desktop-window";

interface WorkspaceChromeProps {
  compactHeader: ReactNode | null;
  inlineHeader?: ReactNode;
  inlineHeaderActive?: boolean;
  tabMeasurement: WorkspaceTabMeasurementInput | null;
  fullHeaderVisible: boolean;
  children: ReactNode;
}

/** Split panes choose chrome from their measured allocation. */
export function AdaptiveWorkspaceChrome(props: WorkspaceChromeProps) {
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0) setWidth(measured);
  }, []);
  return <WorkspaceChrome {...props} width={width} onLayout={measure} />;
}

/** The workspace shell budgets its chrome and the pane below it together. */
export function ProjectedWorkspaceChrome(props: WorkspaceChromeProps) {
  const width = useContext(WindowLayoutPaneWidthContext);
  return <WorkspaceChrome {...props} width={width} />;
}

function WorkspaceChrome(
  props: WorkspaceChromeProps & {
    width: number | null;
    onLayout?: (event: LayoutChangeEvent) => void;
  },
) {
  const content = <WorkspaceChromeContent {...props} />;
  const corners = useWindowChromeCorners();
  return Platform.OS === "ios" ? (
    <WindowChromeProvider corners={corners}>{content}</WindowChromeProvider>
  ) : (
    content
  );
}

function WorkspaceChromeContent({
  compactHeader,
  inlineHeader,
  inlineHeaderActive = false,
  fullHeaderVisible,
  tabMeasurement,
  children,
  width,
  onLayout,
}: WorkspaceChromeProps & {
  width: number | null;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const windowLayout = useWindowLayout();
  const portraitInline = inlineHeaderActive && isPortraitWorkspaceWindow(windowLayout);
  const compact =
    compactHeader !== null &&
    !inlineHeaderActive &&
    selectWorkspaceChrome({ width, compact: true, full: false });
  let chrome = children;
  if (compactHeader !== null && inlineHeaderActive) {
    chrome = inlineHeader;
  } else if (compact) {
    chrome = compactHeader;
  }
  return (
    <WorkspaceHeaderWidthContext.Provider value={width}>
      <WorkspaceHeaderTitleMeasurementScope>
        <WorkspaceTabMeasurementScope input={tabMeasurement}>
          <View style={compact ? styles.compactHeader : styles.header} onLayout={onLayout}>
            <HeaderTopInsetHost
              active={compact || inlineHeaderActive || fullHeaderVisible}
              additionalPadding={compact || portraitInline ? HEADER_TOP_PADDING_MOBILE : 0}
            >
              {chrome}
            </HeaderTopInsetHost>
          </View>
        </WorkspaceTabMeasurementScope>
      </WorkspaceHeaderTitleMeasurementScope>
    </WorkspaceHeaderWidthContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The retained top inset and the header rows must share the same paint owner.
  header: { backgroundColor: theme.colors.surface0 },
  compactHeader: { backgroundColor: theme.colors.surfaceWorkspace },
}));

/** One pane's tabs, as its compact tab switcher and pane menu need them. */
export interface WorkspaceCompactHeaderTabs {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  actions: WorkspaceCompactHeaderActions;
}

export interface WorkspaceCompactHeaderActions {
  pane?: {
    id: string;
    splitRight?: () => void;
    splitDown?: () => void;
    toggleMaximized?: () => void;
    maximized: boolean;
  };
  closeAbove: (key: string) => Promise<void> | void;
  closeBelow: (key: string) => Promise<void> | void;
  closeOthers: (key: string) => Promise<void> | void;
}
