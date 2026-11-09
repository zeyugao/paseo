import { create } from "zustand";
import { persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  clampTreeRailWidth,
  clampSidebarWidth,
  DEFAULT_TREE_RAIL_WIDTH,
  dropOverlayAgentList,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_TREE_RAIL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_TREE_RAIL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  migratePanelState,
  PanelPersistedStateSchema,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
  setMobilePanelTarget,
  reconcileMobilePanel,
  type DesktopSidebarState,
  type MobilePanelView,
  type MobilePanelSelection,
  type PanelLayout,
  type SortOption,
} from "./state";
import { isWeb } from "@/constants/platform";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
export type {
  DesktopSidebarState,
  LeftSidebarPresentation,
  MobilePanelView,
  MobilePanelSelection,
  PanelLayout,
  SortOption,
} from "./state";
export {
  DEFAULT_TREE_RAIL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_TREE_RAIL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_TREE_RAIL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampTreeRailWidth,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
};

export type ExpandedPathsUpdate = string[] | ((currentPaths: string[]) => string[]);

export interface PanelState {
  // Mobile: React's durable target plus the generation that owns it.
  mobilePanel: MobilePanelSelection;

  // Desktop: independent sidebar toggles
  desktop: DesktopSidebarState;

  // Resolved shell capabilities are transient, not saved dock preferences.
  layout: PanelLayout;

  // File explorer settings (shared between mobile/desktop)
  expandedPathsByWorkspace: Record<string, string[]>;
  // Changes-view folder tree. Inverted semantics vs the fields above:
  // this stores COLLAPSED directory paths (empty = all folders expanded), keyed
  // by full uncompressed dir path, so folders default to expanded and new
  // folders stay expanded as the diff changes.
  diffCollapsedFoldersByWorkspace: Record<string, string[]>;
  collapsedFilePathsByWorkspace: Record<string, string[]>;
  sidebarWidth: number;
  explorerSortOption: SortOption;
  explorerShowHiddenFiles: boolean;
  treeRailWidth: number;
  // File panel's tree rail. The changes panel keeps its own flag in
  // `useChangesPreferences`; the two rails open and close independently.
  fileTreeVisible: boolean;

  // Actions
  toggleFocusMode: () => void;
  exitFocusMode: () => void;
  showMobileAgent: () => void;
  showMobileAgentList: () => void;
  showMobileFileExplorer: () => void;
  toggleMobileAgentList: () => void;
  openDesktopAgentList: () => void;
  closeDesktopAgentList: () => void;
  toggleDesktopAgentList: () => void;
  openAgentListForLayout: () => void;
  closeAgentListForLayout: () => void;
  toggleAgentListForLayout: () => void;
  collapseAgentListForLayout: () => void;
  applyPanelLayout: (layout: PanelLayout) => void;

  // File explorer settings actions
  setExpandedPathsForWorkspace: (workspaceKey: string, paths: ExpandedPathsUpdate) => void;
  setDiffCollapsedFoldersForWorkspace: (workspaceKey: string, dirPaths: string[]) => void;
  setCollapsedFilePathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  setSidebarWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  toggleExplorerShowHiddenFiles: () => void;
  setTreeRailWidth: (width: number) => void;
  toggleFileTreeVisible: () => void;
}

const DEFAULT_DESKTOP_OPEN = isWeb;

function setMobilePanelTargetPatch(
  state: PanelState,
  target: MobilePanelView,
): PanelState | Pick<PanelState, "mobilePanel"> {
  const mobilePanel = setMobilePanelTarget(state.mobilePanel, target);
  return mobilePanel === state.mobilePanel ? state : { mobilePanel };
}

function dockAgentListPatch(state: PanelState): Pick<PanelState, "desktop" | "mobilePanel"> {
  return {
    desktop: { ...state.desktop, agentListOpen: true },
    mobilePanel: dropOverlayAgentList(state.mobilePanel),
  };
}

function openAgentListForLayoutPatch(state: PanelState) {
  if (state.layout.leftSidebar === "hidden") {
    if (!state.desktop.focusModeEnabled) return state;
    // Focus hides chrome before it can publish whether navigation will dock or overlay.
    return {
      desktop: {
        ...state.desktop,
        focusModeEnabled: false,
        agentListOpen: state.layout.isCompact ? state.desktop.agentListOpen : true,
      },
      mobilePanel: setMobilePanelTarget(state.mobilePanel, "agent-list"),
    };
  }
  if (selectIsAgentListOpen(state)) return state;
  return state.layout.isCompact || !state.layout.leftDockAvailable
    ? setMobilePanelTargetPatch(state, "agent-list")
    : dockAgentListPatch(state);
}

function closeAgentListForLayoutPatch(state: PanelState) {
  if (state.layout.leftSidebar === "hidden") return state;
  if (state.layout.leftSidebar === "overlay") {
    return state.mobilePanel.target === "agent-list"
      ? setMobilePanelTargetPatch(state, "agent")
      : state;
  }
  return state.desktop.agentListOpen
    ? { desktop: { ...state.desktop, agentListOpen: false } }
    : state;
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobilePanel: { target: "agent", revision: 0 },

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        focusModeEnabled: false,
      },
      layout: { isCompact: true, leftSidebar: "hidden", leftDockAvailable: false },

      // File explorer defaults
      expandedPathsByWorkspace: {},
      diffCollapsedFoldersByWorkspace: {},
      collapsedFilePathsByWorkspace: {},
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerShowHiddenFiles: true,
      treeRailWidth: DEFAULT_TREE_RAIL_WIDTH,
      fileTreeVisible: true,

      toggleFocusMode: () =>
        set((state) => ({
          desktop: { ...state.desktop, focusModeEnabled: !state.desktop.focusModeEnabled },
        })),

      exitFocusMode: () =>
        set((state) =>
          state.desktop.focusModeEnabled
            ? { desktop: { ...state.desktop, focusModeEnabled: false } }
            : state,
        ),

      showMobileAgent: () => set((state) => setMobilePanelTargetPatch(state, "agent")),

      showMobileAgentList: () => set((state) => setMobilePanelTargetPatch(state, "agent-list")),
      showMobileFileExplorer: () =>
        set((state) => setMobilePanelTargetPatch(state, "file-explorer")),

      toggleMobileAgentList: () =>
        set((state) =>
          setMobilePanelTargetPatch(
            state,
            state.mobilePanel.target === "agent-list" ? "agent" : "agent-list",
          ),
        ),

      openDesktopAgentList: () =>
        set((state) => (state.desktop.agentListOpen ? state : dockAgentListPatch(state))),

      closeDesktopAgentList: () =>
        set((state) => {
          if (!state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: false } };
        }),

      toggleDesktopAgentList: () =>
        set((state) =>
          state.desktop.agentListOpen
            ? { desktop: { ...state.desktop, agentListOpen: false } }
            : dockAgentListPatch(state),
        ),

      openAgentListForLayout: () => set(openAgentListForLayoutPatch),
      closeAgentListForLayout: () => set(closeAgentListForLayoutPatch),
      toggleAgentListForLayout: () =>
        set((state) =>
          selectIsAgentListOpen(state)
            ? closeAgentListForLayoutPatch(state)
            : openAgentListForLayoutPatch(state),
        ),
      // Toggle-both clears wide dock intent and cancels any opening overlay swipe.
      collapseAgentListForLayout: () =>
        set((state) => ({
          mobilePanel: dropOverlayAgentList(state.mobilePanel),
          desktop:
            state.layout.isCompact || !state.desktop.agentListOpen
              ? state.desktop
              : { ...state.desktop, agentListOpen: false },
        })),

      applyPanelLayout: (layout) =>
        set((state) => {
          const mobilePanel = reconcileMobilePanel(state.mobilePanel, layout);
          if (
            mobilePanel === state.mobilePanel &&
            state.layout.isCompact === layout.isCompact &&
            state.layout.leftSidebar === layout.leftSidebar &&
            state.layout.leftDockAvailable === layout.leftDockAvailable
          )
            return state;
          return { layout, mobilePanel };
        }),

      setExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => {
          const currentPaths = state.expandedPathsByWorkspace[workspaceKey] ?? ["."];
          const nextPaths = typeof paths === "function" ? paths(currentPaths) : paths;
          return {
            expandedPathsByWorkspace: {
              ...state.expandedPathsByWorkspace,
              [workspaceKey]: nextPaths,
            },
          };
        }),
      setDiffCollapsedFoldersForWorkspace: (workspaceKey, dirPaths) =>
        set((state) => ({
          diffCollapsedFoldersByWorkspace: {
            ...state.diffCollapsedFoldersByWorkspace,
            [workspaceKey]: dirPaths,
          },
        })),
      setCollapsedFilePathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          collapsedFilePathsByWorkspace: {
            ...state.collapsedFilePathsByWorkspace,
            [workspaceKey]: paths,
          },
        })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      toggleExplorerShowHiddenFiles: () =>
        set((state) => ({ explorerShowHiddenFiles: !state.explorerShowHiddenFiles })),
      setTreeRailWidth: (width) => set({ treeRailWidth: clampTreeRailWidth(width) }),
      toggleFileTreeVisible: () => set((state) => ({ fileTreeVisible: !state.fileTreeVisible })),
    }),
    {
      name: "panel-state",
      version: 17,
      storage: createValidatedPersistStorage(AsyncStorage, PanelPersistedStateSchema),
      migrate: (persistedState, version) => migratePanelState(persistedState, version),
      partialize: (state) => ({
        desktop: state.desktop,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
        diffCollapsedFoldersByWorkspace: state.diffCollapsedFoldersByWorkspace,
        collapsedFilePathsByWorkspace: state.collapsedFilePathsByWorkspace,
        sidebarWidth: state.sidebarWidth,
        explorerSortOption: state.explorerSortOption,
        explorerShowHiddenFiles: state.explorerShowHiddenFiles,
        treeRailWidth: state.treeRailWidth,
        fileTreeVisible: state.fileTreeVisible,
      }),
    },
  ),
);
