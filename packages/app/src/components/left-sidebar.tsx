import { SidebarViewSlot } from "@/plugins/sidebar-view";
import { useAddHost } from "@/hosts/add-host";
import {
  CircleGauge,
  FolderPlus,
  GitBranch,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  Gesture,
  type GestureType,
  ScrollView as GHScrollView,
} from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  TitlebarDragRegion,
  WINDOW_CONTENT_DATASET,
} from "@/components/desktop/titlebar-drag-region";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import {
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarWidth,
  usesNativeFlexibleDock,
} from "@/components/desktop-sidebar-layout";
import {
  useTopBand,
  useWindowLayout,
  resolveDesktopDivisionLayout,
  WindowLayoutTopInset,
  WindowLayoutGeometryView,
  resolveWorkspaceActionPlacement,
} from "@/window-layout";
import { useAppWindowSize } from "@/hooks/use-app-window-size";
import { usePublishSidebarResizeWidth } from "@/window-layout/sidebar-resize-geometry";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
import { SidebarNavRows, useVisibleSidebarNavItems } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { SidebarFooterOverflowMenu } from "@/components/sidebar/sidebar-footer-overflow-menu";
import {
  resolveSidebarFooterLayout,
  SIDEBAR_FOOTER_ACTIONS,
  type SidebarFooterAction,
} from "@/components/sidebar-footer-layout";
import {
  controlSizingForLayout,
  bySizing,
  mapLayout,
  TOOLBAR_CONTROL_SIZES,
} from "@/components/ui/control-geometry";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HEADER_INNER_HEIGHT,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { isNative as platformIsNative } from "@/constants/platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density } from "@/styles/density";
import { SPACING } from "@/styles/theme";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useHosts } from "@/runtime/host-runtime";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { MIN_SIDEBAR_WIDTH, usePanelStore } from "@/stores/panel-store";
import {
  useHasOwnedWindowChromeObstruction,
  useWindowChromeInlinePadding,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { useLeftPanelWidth } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { openSettingsFromSidebar } from "@/navigation/settings-navigation";
import { UsageSidebarItem, UsageSidebarRoot, useUsageSummary, useOpenSidebarUsage } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

/** The footer icon line's inset; the overflow layout counts it as space the buttons can't use. */
const FOOTER_ROW_PADDING = SPACING[2];

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleImportSession: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}

interface SidebarLabels {
  addProject: string;
  hosts: string;
  settings: string;
  searchHosts: string;
  usage: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  active: boolean;
  overlay: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({
  active,
  desktopOverlay,
}: {
  active: boolean;
  desktopOverlay: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const activeWorkspace = useActiveWorkspaceSelection();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const { open: openImportSession, sheet: importSessionSheet } = useImportSession();

  // Workspace destinations close the overlay; Settings retains it for the return journey.
  const handleOpenProject = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettings = useCallback(() => {
    openSettingsFromSidebar({ workspace: activeWorkspace, isCompact: isCompactLayout });
  }, [activeWorkspace, isCompactLayout]);

  const openAddHost = useAddHost();
  const handleAddHost = useCallback(() => {
    showMobileAgent();
    openAddHost();
  }, [showMobileAgent, openAddHost]);

  const handleOpenHostSettings = useCallback(
    (serverId: string) => {
      openSettingsFromSidebar({
        workspace: activeWorkspace,
        isCompact: isCompactLayout,
        route: buildSettingsHostSectionRoute(serverId, "host"),
      });
    },
    [activeWorkspace, isCompactLayout],
  );

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      hosts: t("sidebar.actions.hosts"),
      settings: t("sidebar.actions.settings"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      usage: t(builtinSidebarNavLabelKey("usage")),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
  };

  const handlers = {
    handleOpenProject,
    handleImportSession: openImportSession,
    handleSettings,
    handleAddHost,
    handleOpenHostSettings,
  };

  return (
    <>
      <RetainedPanelActivity active={active}>
        {isCompactLayout ? (
          <MobileSidebar
            {...sharedProps}
            {...handlers}
            active={active}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
          />
        ) : (
          <DesktopSidebar {...sharedProps} {...handlers} active={active} overlay={desktopOverlay} />
        )}
      </RetainedPanelActivity>
      {importSessionSheet}
    </>
  );
});

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
}

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <DensityIcon
                icon={icon}
                size="md"
                sizeAdjustment={iconSizeAdjustment}
                color={hovered ? "foreground" : "foregroundMuted"}
              />
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarHostPicker({
  label,
  onAddHost,
  onOpenHostSettings,
}: {
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <FooterIconButton
        buttonRef={triggerRef}
        onPress={handleOpen}
        testID="sidebar-hosts-trigger"
        label={label}
        icon={Server}
        // Server's two boxes fill more of the square than the other glyphs.
        iconSizeAdjustment={-1}
      />
    </HostPicker>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

function SidebarFooter({
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  onBeforeNavigate,
}: {
  handleOpenProject: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    settings: string;
    searchHosts: string;
    usage: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const isCompactLayout = useIsCompactFormFactor();
  const [rowWidth, setRowWidth] = useState(0);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  const { inline, overflow } = useMemo(
    () =>
      resolveSidebarFooterLayout({
        rowWidth,
        controlSize: TOOLBAR_CONTROL_SIZES[controlSizingForLayout(isCompactLayout)],
        rowPadding: FOOTER_ROW_PADDING,
        actions: SIDEBAR_FOOTER_ACTIONS,
      }),
    [rowWidth, isCompactLayout],
  );
  const isInline = (action: SidebarFooterAction) => inline.includes(action);

  // One line of icons: Add project, Usage, Hosts, then Help and Settings at the end. Actions that
  // don't fit move behind a caret before Settings.
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
        <View
          style={styles.sidebarFooter}
          onLayout={handleRowLayout}
          testID="sidebar-footer-bottom-line"
        >
          {isInline("add-project") ? (
            <FooterIconButton
              onPress={handleOpenProject}
              testID="sidebar-add-project"
              label={labels.addProject}
              icon={FolderPlus}
              shortcutKeys={newAgentKeys}
            />
          ) : null}
          {isInline("usage") ? <SidebarUsageIcon label={labels.usage} /> : null}
          {isInline("hosts") ? (
            <SidebarHostPicker
              label={labels.hosts}
              onAddHost={handleAddHost}
              onOpenHostSettings={handleOpenHostSettings}
            />
          ) : null}
          <View style={styles.footerSpacer} />
          {isInline("help") ? <SidebarHelpMenu /> : null}
          {overflow.length > 0 ? (
            <SidebarFooterOverflowMenu
              actions={overflow}
              labels={labels}
              onAddProject={handleOpenProject}
              onSettings={handleSettings}
              onAddHost={handleAddHost}
              onOpenHostSettings={handleOpenHostSettings}
            />
          ) : null}
          {isInline("settings") ? (
            <FooterIconButton
              onPress={handleSettings}
              testID="sidebar-settings"
              label={labels.settings}
              icon={Settings}
              shortcutKeys={settingsKeys}
            />
          ) : null}
        </View>
      </View>
    </UsageSidebarRoot>
  );
}

function SidebarUsageIcon({ label }: { label: string }) {
  const openUsage = useOpenSidebarUsage();
  return (
    <FooterIconButton
      onPress={openUsage}
      testID="sidebar-usage-icon"
      label={label}
      icon={CircleGauge}
    />
  );
}

/**
 * The footer rows in the user's `sidebarFooterItems` order: the Usage item and plugin rows. The
 * Usage item is left out while it has no summary to show.
 */
function SidebarFooterRows({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { items } = useSidebarNavItems("footer");
  const usageSummary = useUsageSummary();
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter(
    (item) => item.visible && (item.kind === "plugin" || usageSummary.length > 0),
  );
  if (visibleItems.length === 0) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {visibleItems.map((item) =>
          item.kind === "plugin" ? (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="footer"
              fallbackAnchorRef={rowsRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ) : (
            <UsageSidebarItem key={item.key} sources={usageSummary} />
          ),
        )}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  active,
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const insets = useSafeAreaInsets();
  const inTopBand = useTopBand() !== null;
  const closesInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const closeButton = useMemo(
    () => (
      <SidebarCloseButton
        label={labels.closeSidebar}
        onPress={closeSidebar}
        testID="sidebar-close"
        nativeID="sidebar-close"
        style={styles.mobileCloseButton(insets.right)}
      />
    ),
    [labels.closeSidebar, closeSidebar, insets.right],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsBottom, theme.colors.surfaceSidebar],
  );

  const navRows = (
    <SidebarNavRows
      style={[
        styles.mobileNavRowsGroup,
        (platformIsNative || inTopBand) && styles.sidebarHeaderGroupFlush,
      ]}
      onBeforeNavigate={closeSidebar}
      firstRowTrailing={closesInBar ? undefined : closeButton}
    />
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowLayoutTopInset
          additionalPadding={platformIsNative ? SPACING[4] : 0}
          landscapePadding={HEADER_TOP_PADDING_MOBILE}
        />
        <WindowChromeSafeArea placement="below" />
        <SidebarNavScroll closeGestureRef={closeGestureRef}>{navRows}</SidebarNavScroll>

        <SidebarViewSlot dismiss={handleWorkspacePress}>
          <SidebarToastRegion active={active}>
            {isInitialLoad && !hasActiveHostFilter ? (
              <SidebarAgentListSkeleton />
            ) : (
              <SidebarWorkspaceList
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                groupMode={groupMode}
                workspaceGroups={workspaceGroups}
                projectIconTargets={projectIconTargets}
                pinnedGroups={pinnedGroups}
                projects={projects}
                hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                hasActiveProjectFilter={hasActiveProjectFilter}
                workspaceEntriesByKey={workspaceEntriesByKey}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onWorkspacePress={handleWorkspacePress}
                onAddProject={handleOpenProject}
                onImportSession={handleImportSession}
                parentGestureRef={closeGestureRef}
                dragGestureHostActive={active}
                listHeaderComponent={workspacesSectionHeaderElement}
              />
            )}
          </SidebarToastRegion>
        </SidebarViewSlot>

        <SidebarFooter
          handleOpenProject={handleOpenProject}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

interface SidebarNavScrollProps {
  closeGestureRef: RefObject<GestureType | undefined>;
  /** Web only: the viewport emits no window regions (see WINDOW_CONTENT_DATASET). */
  windowContent?: boolean;
  children: ReactNode;
}

// The capped, scrolling nav block shared by the mobile and desktop sidebars, with the
// divider below it. The divider is a sibling because Unistyles does not patch the
// gesture-handler ScrollView.
function SidebarNavScroll({ closeGestureRef, windowContent, children }: SidebarNavScrollProps) {
  return (
    <>
      {platformIsNative ? (
        <GHScrollView
          // Same contract as the workspace list: vertical drags scroll the nav
          // block, a clear horizontal intent still activates the close pan.
          simultaneousHandlers={closeGestureRef}
          style={styles.navScroll}
          showsVerticalScrollIndicator={false}
          alwaysBounceVertical={false}
          testID="sidebar-nav-scroll"
        >
          {children}
        </GHScrollView>
      ) : (
        <ScrollView
          dataSet={windowContent ? WINDOW_CONTENT_DATASET : undefined}
          style={styles.navScroll}
          showsVerticalScrollIndicator={false}
          alwaysBounceVertical={false}
          testID="sidebar-nav-scroll"
        >
          {children}
        </ScrollView>
      )}
      <SidebarSeparator testID="sidebar-nav-separator" />
    </>
  );
}

function DesktopSidebar({
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  active,
  overlay,
}: DesktopSidebarProps) {
  const ownsTopLeft = useHasOwnedWindowChromeObstruction("top-left");
  const chromePadding = useWindowChromeInlinePadding();
  const windowLayout = useWindowLayout();
  const hasVerticalBar = resolveWorkspaceActionPlacement(windowLayout) === "vertical-bar";
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: windowWidth, height: windowHeight } = useAppWindowSize();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: windowLayout,
    windowWidth,
    windowHeight,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  const visibleSidebarWidth = useLeftPanelWidth();
  const requestedWidth = usePanelStore((state) => state.sidebarWidth);
  const dockFillsAvailableSpace = usesNativeFlexibleDock(!overlay, divisionLayout !== null);
  const widthBeforeDrag = dockFillsAvailableSpace ? requestedWidth : visibleSidebarWidth;
  const resizeEnabled = active && !overlay && divisionLayout === null;
  const publishSidebarResizeWidth = usePublishSidebarResizeWidth();
  const resizePublication = useMemo(
    () => ({
      active: false,
      enabled: resizeEnabled,
      width: visibleSidebarWidth,
      publish: publishSidebarResizeWidth,
    }),
    [publishSidebarResizeWidth, resizeEnabled, visibleSidebarWidth],
  );
  const publishResizeWidth = useCallback(
    (width: number | null) => {
      if (resizePublication.active) resizePublication.publish(width);
    },
    [resizePublication],
  );

  const closeSidebar = usePanelStore((state) => state.showMobileAgent);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture(overlay);

  const startWidth = useSharedValue(visibleSidebarWidth);
  const resizeWidth = useSharedValue(widthBeforeDrag);
  const resizing = useSharedValue(false);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizePublication.active = resizePublication.enabled;
    resizing.value = false;
    resizeWidth.value = widthBeforeDrag;
    setResizePressed(false);
    return () => {
      // Reject queued updates from the old allocation after clearing its sample.
      resizePublication.active = false;
      resizePublication.publish(null);
    };
  }, [resizePublication, resizeWidth, resizing, widthBeforeDrag]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(resizeEnabled)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          resizing.value = true;
          startWidth.value = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
          runOnJS(publishResizeWidth)(resizeWidth.value);
        })
        .onUpdate((event) => {
          if (!resizing.value) return;
          // Dragging right (positive translationX) increases width
          const newWidth = startWidth.value + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
          runOnJS(publishResizeWidth)(resizeWidth.value);
        })
        .onEnd((_event, success) => {
          if (success && resizing.value) runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize((_event, success) => {
          if (!success && resizing.value) resizeWidth.value = widthBeforeDrag;
          resizing.value = false;
          runOnJS(publishResizeWidth)(null);
          scheduleOnRN(hideResizeGrip);
        }),
    [
      resizeEnabled,
      hideResizeGrip,
      publishResizeWidth,
      resizeWidth,
      resizing,
      setSidebarWidth,
      showResizeGrip,
      startWidth,
      viewportWidth,
      visibleSidebarWidth,
      widthBeforeDrag,
    ],
  );

  // When docked, Yoga clamps the requested width against the center's minimum
  // in the same layout that mounts the current native safe-area spacers.
  const dockWidthStyle = useAnimatedStyle(() => ({
    width: dockFillsAvailableSpace ? resizeWidth.value : undefined,
  }));
  // The dock host can grow after a viewport clamp. Resolve the inner panel's
  // width against that allocation so its fill, divider, and grip share the edge.
  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: dockFillsAvailableSpace
      ? ("100%" as const)
      : (divisionLayout?.sidebarWidth ?? resizeWidth.value),
  }));
  // Other docks size to this child; moving the animated width onto the host on Android
  // can leave a stale width there when Android switches presentation.
  const desktopSidebarStyle = useMemo(
    () => [staticStyles.desktopSidebar, resizeAnimatedStyle],
    [resizeAnimatedStyle],
  );
  const desktopSidebarSurfaceStyle = useMemo(
    () => [
      styles.desktopSidebarSurface,
      divisionLayout === null && styles.desktopSidebarDividerInset,
      {
        flex: 1,
        paddingBottom: insets.bottom,
        paddingLeft: resolveDesktopSidebarInsetLeft({
          overlay,
          safeAreaLeft: insets.left,
          hasVerticalBar,
        }),
      },
    ],
    [insets.bottom, insets.left, overlay, divisionLayout, hasVerticalBar],
  );
  const { devBuildLabel, showsChromeRow, hasNavRows, showsDragStrip } =
    useSidebarNavChrome(ownsTopLeft);
  const { theme } = useUnistyles();
  return (
    <MobilePanelOverlay
      panel="agent-list"
      presentation={overlay ? "overlay" : "dock"}
      dockVisible={active}
      frameStyle={dockFillsAvailableSpace ? [staticStyles.flexibleDock, dockWidthStyle] : undefined}
      closeGesture={closeGesture}
    >
      <Animated.View style={desktopSidebarStyle}>
        <View style={desktopSidebarSurfaceStyle}>
          <WindowLayoutTopInset
            additionalPadding={platformIsNative && !ownsTopLeft ? SPACING[4] : 0}
            landscapePadding={HEADER_TOP_PADDING_MOBILE}
          />
          <WindowLayoutGeometryView style={[styles.sidebarDragArea, chromePadding]}>
            {showsChromeRow ? (
              <View style={styles.desktopChromeRow}>
                <TitlebarDragRegion />
                {devBuildLabel ? (
                  <View
                    pointerEvents="none"
                    style={styles.devBuildBadge}
                    testID="dev-build-label"
                    accessibilityLabel={`Development build: ${devBuildLabel}`}
                  >
                    <GitBranch size={12} color={theme.colors.accentForeground} />
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                      {devBuildLabel}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {showsDragStrip ? (
              <View style={styles.desktopDragStrip} testID="sidebar-nav-drag-strip">
                <TitlebarDragRegion />
              </View>
            ) : null}
          </WindowLayoutGeometryView>
          {/* The drag overlay stays above this viewport: Electron does not clip
              app-region rects to scroll viewports, so a scrolled-out row would
              still claim its no-drag rect. */}
          {hasNavRows ? (
            <SidebarNavScroll closeGestureRef={closeGestureRef} windowContent>
              <SidebarNavRows style={styles.sidebarHeaderGroup} onBeforeNavigate={closeSidebar} />
            </SidebarNavScroll>
          ) : null}

          <SidebarViewSlot dismiss={closeSidebar}>
            <SidebarToastRegion active={active}>
              {isInitialLoad && !hasActiveHostFilter ? (
                <SidebarAgentListSkeleton />
              ) : (
                <SidebarWorkspaceList
                  collapsedProjectKeys={collapsedProjectKeys}
                  onToggleProjectCollapsed={toggleProjectCollapsed}
                  shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                  groupMode={groupMode}
                  workspaceGroups={workspaceGroups}
                  projectIconTargets={projectIconTargets}
                  pinnedGroups={pinnedGroups}
                  projects={projects}
                  hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                  hasActiveProjectFilter={hasActiveProjectFilter}
                  workspaceEntriesByKey={workspaceEntriesByKey}
                  isRefreshing={isManualRefresh && isRevalidating}
                  onRefresh={handleRefresh}
                  onAddProject={handleOpenProject}
                  onImportSession={handleImportSession}
                  onWorkspacePress={closeSidebar}
                  parentGestureRef={closeGestureRef}
                  dragGestureHostActive={active}
                  listHeaderComponent={workspacesSectionHeaderElement}
                />
              )}
            </SidebarToastRegion>
          </SidebarViewSlot>

          <SidebarCalloutSlot />

          <SidebarFooter
            handleOpenProject={handleOpenProject}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
            onBeforeNavigate={closeSidebar}
          />

          {divisionLayout === null ? (
            <View pointerEvents="none" style={styles.desktopSidebarDivider} />
          ) : null}

          {!overlay && divisionLayout === null ? (
            <SidebarResizeHandle
              edge="right"
              gesture={resizeGesture}
              pressed={resizePressed}
              testID="left-sidebar-resize-handle"
            />
          ) : null}
        </View>
      </Animated.View>
    </MobilePanelOverlay>
  );
}

function useSidebarNavChrome(ownsTopLeft: boolean) {
  const inTopBand = useTopBand() !== null;
  const devBuildLabel = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;
  const showsChromeRow = ownsTopLeft || Boolean(devBuildLabel);
  // Without nav rows, the sidebar starts at Workspaces with no drag strip.
  const hasNavRows = useVisibleSidebarNavItems().length > 0;
  // On Windows and Linux the controls are top-right; this strip is the drag surface.
  const showsDragStrip = hasNavRows && !showsChromeRow && !inTopBand;
  return { devBuildLabel, showsChromeRow, hasNavRows, showsDragStrip };
}

function WorkspacesSectionHeader() {
  return (
    <SidebarSectionHeader title="Workspaces">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View>
            <SidebarDisplayPreferencesMenu />
          </View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label="Display preferences" />
        </TooltipContent>
      </Tooltip>
    </SidebarSectionHeader>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).
const workspacesSectionHeaderElement = <WorkspacesSectionHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  flexibleDock: { flexShrink: 1, minWidth: MIN_SIDEBAR_WIDTH },
  desktopSidebar: {
    position: "relative" as const,
    flex: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  // The rows start flush: the chrome row, drag strip, or top band above them gives the inset.
  sidebarHeaderGroup: {
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sidebarHeaderGroupFlush: {
    paddingTop: 0,
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  desktopDragStrip: {
    position: "relative",
    height: theme.spacing[2],
  },
  // The nav block caps at half the sidebar; a long item list scrolls inside the
  // cap instead of crowding the workspace list off a short screen.
  navScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "50%",
  },
  mobileNavRowsGroup: {
    paddingTop: bySizing({ touch: theme.spacing[4], pointer: theme.spacing[2] }),
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButton: (rightInset: number) => ({
    marginRight: theme.spacing[2] + rightInset,
  }),
  desktopSidebarSurface: {
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarDividerInset: {
    paddingRight: 1,
  },
  // Keep the fill on the panel layer during rotation. Fabric paints a single
  // border edge on separate layers at the destination bounds.
  desktopSidebarDivider: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 1,
    backgroundColor: theme.colors.border,
  },
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  // As tall as its buttons from the first frame, which places none until the row has measured.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: mapLayout(density.iconButton, (height) => height + theme.spacing[1.5] * 2),
    paddingHorizontal: FOOTER_ROW_PADDING,
    paddingVertical: theme.spacing[1.5],
  },
  // Pushes Help and Settings to the end of the icon line.
  footerSpacer: {
    flex: 1,
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
