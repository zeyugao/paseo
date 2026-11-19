import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { CompactHeader, CompactHeaderTitle } from "@/components/headers/compact-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useSidebarMenuTogglePresentation } from "@/components/headers/sidebar-menu-toggle";
import {
  HeaderLeading,
  headerContentPaddingForLayout,
  headerNavigationGapForLayout,
  headerNavigationWidthForLayout,
} from "@/components/headers/header-leading";
import {
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type TextProps,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  WindowChromeProvider,
  useWindowChromeCorners,
  useWindowChromeInlinePadding,
} from "@/utils/desktop-window";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
  WindowLayoutGeometryView,
} from "@/window-layout";
import { WindowLayoutHeaderActions } from "@/window-layout/actions";
import { InlineWindowActions } from "@/window-layout/action-plane";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import {
  WORKSPACE_INLINE_TABS_MIN_WIDTH,
  isPortraitWorkspaceWindow,
  resolveInlineWorkspaceTabPresentation,
  resolveInlineWorkspaceTabBudget,
  resolveInlineWorkspaceTitleWidth,
} from "@/screens/workspace/workspace-tab-layout";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions, type GitActions } from "@/git/use-actions";
import {
  WorkspaceHeaderWidthContext,
  useWorkspaceHeaderGitInOverflow,
} from "@/screens/workspace/use-workspace-header-width";
import { useWorkspaceTabIntrinsicWidth } from "@/screens/workspace/workspace-desktop-tabs-row";
import { controlSizingForLayout, ICON_BUTTON_SIZES } from "@/components/ui/control-geometry";
import {
  COMPACT_CONTENT_WIDTH,
  HEADER_INNER_HEIGHT,
  isCompactBreakpoint,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useHostBadges } from "@/hosts/use-host-badges";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { WindowLayout } from "@/window-layout/model";
import InlineHeaderLayout from "./inline-header-layout";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

/** Preferred title width, independent of the visible row's current allocation. */
const INLINE_WORKSPACE_TITLE_MAX_WIDTH = 240;

interface WorkspaceHeaderTitleMetrics {
  widths: ReadonlyMap<string, number>;
  textWidths: ReadonlyMap<string, number>;
  recordWidth: (signature: string, width: number) => void;
  recordTextWidth: (signature: string, width: number) => void;
}

const WorkspaceHeaderTitleMetricsContext = createContext<WorkspaceHeaderTitleMetrics | null>(null);

/** Intrinsic text metrics survive header/rail variant changes, never window geometry. */
export function WorkspaceHeaderTitleMeasurementScope({ children }: { children: ReactNode }) {
  if (Platform.OS === "ios") return children;
  return <ReactTitleMeasurementScope>{children}</ReactTitleMeasurementScope>;
}

function ReactTitleMeasurementScope({ children }: { children: ReactNode }) {
  const [widths, setWidths] = useState(() => new Map<string, number>());
  const [textWidths, setTextWidths] = useState(() => new Map<string, number>());
  const recordWidth = useCallback((signature: string, width: number) => {
    if (!Number.isFinite(width) || width < 0) return;
    const preferredWidth = Math.min(INLINE_WORKSPACE_TITLE_MAX_WIDTH, width);
    setWidths((current) => {
      if (current.get(signature) === preferredWidth) return current;
      const next = new Map(current);
      next.set(signature, preferredWidth);
      return next;
    });
  }, []);
  const recordTextWidth = useCallback((signature: string, width: number) => {
    if (!Number.isFinite(width) || width < 0) return;
    setTextWidths((current) => {
      if (current.get(signature) === width) return current;
      const next = new Map(current);
      next.set(signature, width);
      return next;
    });
  }, []);
  const metrics = useMemo(
    () => ({ widths, textWidths, recordWidth, recordTextWidth }),
    [widths, textWidths, recordWidth, recordTextWidth],
  );
  return (
    <WorkspaceHeaderTitleMetricsContext.Provider value={metrics}>
      {children}
    </WorkspaceHeaderTitleMetricsContext.Provider>
  );
}

function WorkspaceHeaderTitleMeasurement({
  signature,
  loading,
  title,
  projectRow,
}: {
  signature: string;
  loading: boolean;
  title: string;
  projectRow?: ReactNode;
}) {
  const metrics = useContext(WorkspaceHeaderTitleMetricsContext);
  const recordWidth = metrics?.recordWidth;
  const recordTextWidth = metrics?.recordTextWidth;
  const measure = useCallback(
    (event: LayoutChangeEvent) => recordWidth?.(signature, event.nativeEvent.layout.width),
    [recordWidth, signature],
  );
  const measureText = useCallback<NonNullable<TextProps["onTextLayout"]>>(
    (event) => recordTextWidth?.(signature, event.nativeEvent.lines[0]?.width ?? 0),
    [recordTextWidth, signature],
  );
  return (
    <View style={styles.measuringTitleText} onLayout={measure}>
      <CompactHeaderTitle
        loading={loading}
        title={title}
        subtitle={projectRow}
        onTitleTextLayout={measureText}
      />
    </View>
  );
}

interface CompactWorkspaceHeaderProps {
  serverId: string;
  workspaceDirectory?: string | null;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  tabSwitcher: ReactNode;
  inlineTabRail?: ReactNode;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full" | "inline";
  actionsActive: boolean;
}

interface InlineWorkspaceHeaderProps {
  loading: boolean;
  title: string;
  projectRow: ReactNode;
  tabRail: ReactNode;
  tabSwitcher: ReactNode;
  actions: ReactNode;
  actionSlotId?: string;
  preferredTitleWidth: number;
  intrinsicTitleWidth?: number;
  actionsWidth: number;
  pickerWidth: number;
  actionGap: number;
  horizontalPadding: number;
  navigationGap: number;
  navigationControlWidth: number;
  tabGap: number;
  singleTitleFontSize: number;
  projectTitleFontSize: number;
}

function InlineHeaderLeading({
  loading,
  title,
  projectRow,
  retainProject,
  expanded,
  reservedTitleWidth,
  overflow,
  children,
}: Pick<InlineWorkspaceHeaderProps, "loading" | "title" | "projectRow"> & {
  retainProject: boolean;
  expanded: boolean;
  reservedTitleWidth: number;
  overflow?: boolean;
  children: ReactNode;
}) {
  // Both presentations share a retained host: the flexible branch must replace
  // the track presentation's explicit width, not merely omit that property.
  const titleStyle = useMemo(
    () => [
      inlineUnistylesStyle({
        flex: expanded ? 1 : 0,
        width: expanded ? ("auto" as const) : reservedTitleWidth,
        minWidth: expanded ? 0 : reservedTitleWidth,
        maxWidth: expanded ? ("100%" as const) : INLINE_WORKSPACE_TITLE_MAX_WIDTH,
      }),
    ],
    [expanded, reservedTitleWidth],
  );
  return (
    <HeaderLeading navigation="menu">
      <View style={styles.inlineContent}>
        <WindowLayoutGeometryView nativeID="paseo-inline-title" style={titleStyle}>
          <CompactHeaderTitle
            loading={loading}
            title={title}
            titleTestID="workspace-header-title"
            subtitle={projectRow}
            retainProject={retainProject}
            fadeOverflow
            overflow={overflow}
          />
        </WindowLayoutGeometryView>
        {children}
      </View>
    </HeaderLeading>
  );
}

function InlinePickerSlot({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(true);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(event.nativeEvent.layout.width > 0);
  }, []);
  return (
    <View nativeID="paseo-inline-picker" style={styles.switcherAction} onLayout={onLayout}>
      <RetainedPanelActivity active={available}>{children}</RetainedPanelActivity>
    </View>
  );
}

function renderInlineHeaderActions({
  picker,
  tabSwitcher,
  actions,
  nativeAllocation,
  actionSlotId,
}: Pick<InlineWorkspaceHeaderProps, "tabSwitcher" | "actions" | "actionSlotId"> & {
  picker: boolean;
  nativeAllocation: boolean;
}) {
  if (!nativeAllocation && !picker && !actions) return undefined;
  return (
    <>
      {nativeAllocation ? (
        <InlinePickerSlot>{tabSwitcher}</InlinePickerSlot>
      ) : (
        picker && tabSwitcher
      )}
      {actions ? (
        <WindowLayoutHeaderActions
          nativeID={actionSlotId}
          style={[styles.inlineActions, nativeAllocation && !picker && styles.switcherAction]}
        >
          {actions}
        </WindowLayoutHeaderActions>
      ) : null}
    </>
  );
}

function resolveReactInlineHeader(
  input: Omit<Parameters<typeof resolveInlineWorkspaceTabBudget>[0], "width">,
  width: number | null,
  naturalWidth: number | null,
  intrinsicTitleWidth: number | undefined,
) {
  const allocation = resolveInlineWorkspaceTabBudget({ ...input, width: width ?? 0 });
  const picker =
    resolveInlineWorkspaceTabPresentation(allocation.railWidth, naturalWidth) === "switcher";
  const visibleTitleWidth = resolveInlineWorkspaceTitleWidth({
    titleWidth: allocation.titleWidth,
    preferredTitleWidth: input.titleWidth,
    railWidth: allocation.railWidth,
    naturalRailWidth: naturalWidth,
  });
  const titleViewport = picker ? allocation.pickerTitleWidth : visibleTitleWidth;
  return {
    picker,
    visibleTitleWidth,
    titleOverflow:
      width !== null && intrinsicTitleWidth !== undefined
        ? intrinsicTitleWidth > titleViewport + 1
        : undefined,
    railWidth: Math.min(naturalWidth ?? allocation.railWidth, allocation.railWidth),
  };
}

const NATIVE_INLINE_HEADER_SEED = {
  picker: true,
  visibleTitleWidth: 0,
  titleOverflow: undefined,
  railWidth: 0,
};

function InlineWorkspaceHeaderBase({
  loading,
  title,
  projectRow,
  tabRail,
  tabSwitcher,
  actions,
  actionSlotId,
  preferredTitleWidth,
  intrinsicTitleWidth,
  actionsWidth,
  pickerWidth,
  actionGap,
  horizontalPadding,
  navigationGap,
  navigationControlWidth,
  tabGap,
  singleTitleFontSize,
  projectTitleFontSize,
}: InlineWorkspaceHeaderProps) {
  const headerWidth = useContext(WorkspaceHeaderWidthContext);
  const naturalWidth = useWorkspaceTabIntrinsicWidth();
  const nativeAllocation = Platform.OS === "ios";
  const renderedWidth = nativeAllocation ? null : headerWidth;
  const headerWidthStyle = useMemo(
    () => ({
      width: renderedWidth ?? ("100%" as const),
      height: Platform.OS === "ios" ? HEADER_INNER_HEIGHT : undefined,
    }),
    [renderedWidth],
  );
  const chrome = useWindowChromeInlinePadding();
  const navigationVisible = useSidebarMenuTogglePresentation() !== "hidden";
  const horizontalInset = chrome.paddingLeft + chrome.paddingRight + horizontalPadding * 2;
  const navigationWidth = navigationVisible ? navigationControlWidth : 0;
  // Fabric owns the iOS title, rail and picker from the parent's actual allocation.
  // The React path remains the allocator on platforms without the header layout node.
  const { picker, visibleTitleWidth, titleOverflow, railWidth } = nativeAllocation
    ? NATIVE_INLINE_HEADER_SEED
    : resolveReactInlineHeader(
        {
          horizontalInset,
          navigationWidth,
          titleWidth: preferredTitleWidth,
          navigationGap: navigationVisible ? navigationGap : 0,
          actionsWidth,
          pickerWidth,
          actionGap,
          gap: tabGap,
        },
        headerWidth,
        naturalWidth,
        intrinsicTitleWidth,
      );
  const initialRailWidth = nativeAllocation ? (naturalWidth ?? 0) : railWidth;
  const railWidthStyle = useMemo(() => ({ width: initialRailWidth }), [initialRailWidth]);
  const railStyle = useMemo(
    () => [styles.inlineRail, railWidthStyle, picker && styles.measuringRail],
    [railWidthStyle, picker],
  );
  const visibleLeading = useMemo(
    () => (
      <InlineHeaderLeading
        loading={loading}
        title={title}
        projectRow={projectRow}
        retainProject={nativeAllocation}
        expanded={picker}
        reservedTitleWidth={visibleTitleWidth}
        overflow={titleOverflow}
      >
        <WindowLayoutGeometryView
          nativeID="paseo-inline-rail"
          style={railStyle}
          pointerEvents={picker ? "none" : "box-none"}
          accessibilityElementsHidden={picker}
          importantForAccessibility={picker ? "no-hide-descendants" : "auto"}
        >
          {tabRail}
        </WindowLayoutGeometryView>
      </InlineHeaderLeading>
    ),
    [
      loading,
      title,
      projectRow,
      nativeAllocation,
      picker,
      visibleTitleWidth,
      titleOverflow,
      railStyle,
      tabRail,
    ],
  );
  const right = renderInlineHeaderActions({
    picker,
    tabSwitcher,
    actions,
    nativeAllocation,
    actionSlotId,
  });
  const nativeBudget = nativeAllocation
    ? {
        titleWidthCap: INLINE_WORKSPACE_TITLE_MAX_WIDTH,
        singleTitleFontSize,
        projectTitleFontSize,
        compactContentWidth: COMPACT_CONTENT_WIDTH,
        naturalRailWidth: naturalWidth ?? undefined,
        scrollingFloor: WORKSPACE_INLINE_TABS_MIN_WIDTH,
        navigationControlWidth,
        navigationGap,
        actionFrameWidth: pickerWidth,
        actionGap,
        tabGap,
      }
    : null;
  return (
    <InlineHeaderLayout {...nativeBudget} style={headerWidthStyle}>
      <ScreenHeader
        rowNativeID={nativeAllocation ? "paseo-inline-row" : undefined}
        right={right}
        rightStyle={Platform.OS !== "ios" && right ? styles.switcherAction : undefined}
        borderless
      >
        {visibleLeading}
      </ScreenHeader>
    </InlineHeaderLayout>
  );
}

const InlineWorkspaceHeader = withUnistyles(InlineWorkspaceHeaderBase, (theme) => ({
  horizontalPadding: headerContentPaddingForLayout(false),
  navigationGap: headerNavigationGapForLayout(false),
  navigationControlWidth: headerNavigationWidthForLayout(false),
  tabGap: theme.spacing[4],
  singleTitleFontSize: theme.fontSize.lg,
  projectTitleFontSize: theme.fontSize.base,
}));

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader(props: CompactWorkspaceHeaderProps) {
  const metrics = useContext(WorkspaceHeaderTitleMetricsContext);
  const header =
    props.headerVariant === "inline" && props.workspaceDirectory ? (
      <CompactWorkspaceHeaderWithGit {...props} workspaceDirectory={props.workspaceDirectory} />
    ) : (
      <CompactWorkspaceHeaderContent {...props} gitActions={null} />
    );
  return metrics ? (
    header
  ) : (
    <WorkspaceHeaderTitleMeasurementScope>{header}</WorkspaceHeaderTitleMeasurementScope>
  );
}

function CompactWorkspaceHeaderWithGit(
  props: CompactWorkspaceHeaderProps & { workspaceDirectory: string },
) {
  const { gitActions } = useGitActions({
    serverId: props.serverId,
    cwd: props.workspaceDirectory,
    icons: GIT_ACTION_ICONS,
  });
  return <CompactWorkspaceHeaderContent {...props} gitActions={gitActions} />;
}

function resolveProjectPresentation(
  layout: WindowLayout | null,
  headerVariant: CompactWorkspaceHeaderProps["headerVariant"],
  projectRow: ReactNode,
) {
  if (Platform.OS === "ios" && headerVariant === "inline") {
    // The native header allocates the retained row; React provides only its content.
    return { visible: false, projectRow };
  }
  const visible = !isPortraitWorkspaceWindow(layout);
  return { visible, projectRow: visible ? projectRow : null };
}

function resolveHeaderTitleMetrics(
  metrics: WorkspaceHeaderTitleMetrics | null,
  titleOnlySignature: string,
  projectSignature: string,
  showProject: boolean,
) {
  const singleTitleWidth =
    metrics?.widths.get(titleOnlySignature) ?? INLINE_WORKSPACE_TITLE_MAX_WIDTH;
  const projectTitleWidth =
    metrics?.widths.get(projectSignature) ?? INLINE_WORKSPACE_TITLE_MAX_WIDTH;
  return {
    preferredTitleWidth: showProject ? projectTitleWidth : singleTitleWidth,
    intrinsicTitleWidth: metrics?.textWidths.get(
      showProject ? projectSignature : titleOnlySignature,
    ),
  };
}

function assembleHeaderActions(
  variant: CompactWorkspaceHeaderProps["headerVariant"],
  symbols: Record<"tab-count" | "git" | "overflow" | "explorer", ReactNode>,
  nativeInlineGit: boolean,
  actionFrameWidth: number,
  actionGap: number,
  slotSize: { width: number; height: number },
) {
  const descriptors = resolveWorkspaceBarActions(variant).filter(
    (symbol) => symbols[symbol] != null,
  );
  const actions = descriptors.map((symbol) =>
    nativeInlineGit && symbol === "git" ? (
      <WindowLayoutGeometryView key={symbol} nativeID="paseo-inline-git">
        {symbols.git}
      </WindowLayoutGeometryView>
    ) : (
      <Fragment key={symbol}>{symbols[symbol]}</Fragment>
    ),
  );
  return {
    actions: actions.length ? actions : null,
    slots:
      nativeInlineGit &&
      descriptors.map((symbol) => (
        <WindowLayoutGeometryView
          key={symbol}
          nativeID={symbol === "git" ? "paseo-inline-git" : undefined}
          style={slotSize}
          pointerEvents="none"
        />
      )),
    width: descriptors.length * actionFrameWidth + Math.max(0, descriptors.length - 1) * actionGap,
  };
}

function CompactWorkspaceHeaderContentBase({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  tabSwitcher,
  inlineTabRail,
  serverId,
  headerVariant,
  actionsActive,
  gitActions,
  titleTypographySignature,
  actionFrameWidth,
  actionGap,
}: CompactWorkspaceHeaderProps & {
  gitActions: GitActions | null;
  titleTypographySignature: string;
  actionFrameWidth: number;
  actionGap: number;
}) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const isCompact = useIsCompactFormFactor();
  const hostBadge = useHostBadges({ enabled: isCompact }).get(serverId) ?? null;
  const windowLayout = useWindowLayout();
  const actionsInBar = resolveWorkspaceActionPlacement(windowLayout) === "vertical-bar";
  const gitInOverflow = useWorkspaceHeaderGitInOverflow();
  const paneWidth = useContext(WorkspaceHeaderWidthContext);
  const corners = useWindowChromeCorners();
  const actionSlotId = `paseo-inline-actions:${useId()}`;
  const metrics = useContext(WorkspaceHeaderTitleMetricsContext);
  const fullProjectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId],
  );
  const measurementProjectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
        measurement
      />
    ),
    [subtitle, isSubtitleDistinct, serverId],
  );
  const project = resolveProjectPresentation(windowLayout, headerVariant, fullProjectRow);
  // Orientation selects a presentation, never the validity of either intrinsic variant.
  const typography = JSON.stringify([fontScale, isCompact, titleTypographySignature]);
  const titleOnlySignature = JSON.stringify(["title", isLoading, title, typography]);
  const projectSignature = JSON.stringify([
    "project",
    isLoading,
    title,
    subtitle,
    isSubtitleDistinct,
    serverId,
    hostBadge,
    typography,
  ]);
  // Cold content reserves the full title cap. Below the scrolling floor an unknown
  // rail uses the picker; no prior title, orientation, or presentation can decide fit.
  const { preferredTitleWidth, intrinsicTitleWidth } = resolveHeaderTitleMetrics(
    metrics,
    titleOnlySignature,
    projectSignature,
    project.visible,
  );
  const hasGitActions =
    gitActions !== null &&
    (gitActions.primary !== null || gitActions.secondary.length > 0 || gitActions.menu.length > 0);
  const nativeInlineGit = Platform.OS === "ios" && headerVariant === "inline";
  const symbols = {
    "tab-count": tabSwitcher,
    git:
      gitActions && hasGitActions && (nativeInlineGit || !gitInOverflow) ? (
        <GitActionsSplitButton gitActions={gitActions} menuOnly menuTrigger="icon" />
      ) : null,
    overflow: children,
    explorer: (
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    ),
  };
  const slotSize = useMemo(
    () => ({ width: actionFrameWidth, height: actionFrameWidth }),
    [actionFrameWidth],
  );
  const {
    actions,
    slots,
    width: inlineActionsWidth,
  } = assembleHeaderActions(
    headerVariant,
    symbols,
    nativeInlineGit,
    actionFrameWidth,
    actionGap,
    slotSize,
  );
  const actionsWidth = actionsInBar ? 0 : inlineActionsWidth;
  const inlineActions = nativeInlineGit ? slots : !actionsInBar && actions;

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          navigation="menu"
          title={title}
          titleTestID="workspace-header-title"
          subtitle={project.projectRow}
          loading={isLoading}
          actions={actions}
          actionsFollowWindowBar
        />
      ) : null}
      {headerVariant === "inline" ? (
        <InlineWorkspaceHeader
          loading={isLoading}
          title={title}
          projectRow={project.projectRow}
          tabRail={inlineTabRail}
          tabSwitcher={tabSwitcher}
          actionSlotId={nativeInlineGit ? actionSlotId : undefined}
          actions={inlineActions}
          preferredTitleWidth={preferredTitleWidth}
          intrinsicTitleWidth={intrinsicTitleWidth}
          actionsWidth={actionsWidth}
          pickerWidth={actionFrameWidth}
          actionGap={actionGap}
        />
      ) : null}
      {nativeInlineGit ? (
        <InlineWindowActions id={actionSlotId} active={actionsActive}>
          <WindowChromeProvider corners={corners}>
            <WorkspaceHeaderWidthContext.Provider value={paneWidth}>
              {actions}
            </WorkspaceHeaderWidthContext.Provider>
          </WindowChromeProvider>
        </InlineWindowActions>
      ) : (
        <WindowLayoutActions active={actionsActive}>{actions}</WindowLayoutActions>
      )}
      {Platform.OS !== "ios" ? (
        <ScrollView
          horizontal
          scrollEnabled={false}
          style={styles.titleMeasurement}
          pointerEvents="none"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          showsHorizontalScrollIndicator={false}
        >
          <WorkspaceHeaderTitleMeasurement
            key={titleOnlySignature}
            signature={titleOnlySignature}
            loading={isLoading}
            title={title}
          />
          <WorkspaceHeaderTitleMeasurement
            key={projectSignature}
            signature={projectSignature}
            loading={isLoading}
            title={title}
            projectRow={measurementProjectRow}
          />
        </ScrollView>
      ) : null}
    </IconButtonChromeProvider>
  );
}

const CompactWorkspaceHeaderContent = withUnistyles(
  CompactWorkspaceHeaderContentBase,
  (theme, runtime) => ({
    titleTypographySignature: JSON.stringify([
      theme.fontFamily.ui,
      theme.fontSize.sm,
      theme.fontSize.base,
      theme.fontSize.lg,
      theme.fontWeight.medium,
      theme.spacing[1.5],
    ]),
    actionFrameWidth:
      ICON_BUTTON_SIZES.large[controlSizingForLayout(isCompactBreakpoint(runtime.breakpoint))],
    actionGap: theme.spacing[2],
  }),
);

const styles = StyleSheet.create((theme) => ({
  titleMeasurement: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
  switcherAction: { marginLeft: theme.spacing[4] },
  inlineActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  measuringTitleText: {
    flexShrink: 0,
    minWidth: 0,
  },
  inlineContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  inlineRail: { flexShrink: 1, minWidth: 0, maxWidth: "100%", overflow: "hidden" },
  measuringRail: { position: "absolute", opacity: 0 },
}));
