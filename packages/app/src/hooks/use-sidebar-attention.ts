import { useMemo } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { selectSidebarAttentionBucket } from "@/utils/sidebar-attention";
import { useSidebarWorkspacesList } from "./use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "./use-sidebar-workspace-entries";

/** Independent of SidebarModelProvider: window-owned chrome lives outside that provider. */
export function useSidebarAttention(sidebarOpen: boolean) {
  const list = useSidebarWorkspacesList({ enabled: !sidebarOpen });
  const entries = useSidebarWorkspaceEntries(list.workspacePlacements, !sidebarOpen);
  const activeSelection = useActiveWorkspaceSelection();
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const availableProjectKeys = useMemo(
    () => new Set(list.projects.map((project) => project.viewKey)),
    [list.projects],
  );
  return useMemo(
    () =>
      selectSidebarAttentionBucket({
        sidebarOpen,
        workspaces: [...entries.values()],
        availableProjectKeys,
        projectFilters,
        labelFilter,
        showBackground,
        activeSelection,
      }),
    [
      sidebarOpen,
      entries,
      availableProjectKeys,
      projectFilters,
      labelFilter,
      showBackground,
      activeSelection,
    ],
  );
}
