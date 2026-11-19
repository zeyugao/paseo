import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { SidebarLabelFilter } from "@/stores/sidebar-view-store";
import { filterWorkspacesByLabels } from "@/components/sidebar/sidebar-labels";
import {
  filterWorkspacesByProjects,
  resolveActiveProjectFilters,
} from "@/components/sidebar/sidebar-project-filter";
import { resolveAttentionBucket, type AttentionBucket } from "./attention-indicator";

/** Entries come from sidebar placements, so host filtering and archive removal already apply. */
export function selectSidebarAttentionBucket(input: {
  sidebarOpen: boolean;
  workspaces: readonly SidebarWorkspaceEntry[];
  availableProjectKeys: ReadonlySet<string>;
  projectFilters: readonly string[];
  labelFilter: SidebarLabelFilter;
  showBackground: boolean;
  activeSelection: ActiveWorkspaceSelection | null;
}): AttentionBucket | null {
  if (input.sidebarOpen) return null;
  const byProject = filterWorkspacesByProjects({
    workspaces: input.workspaces,
    projectFilters: resolveActiveProjectFilters(input.projectFilters, input.availableProjectKeys),
  });
  const visible = filterWorkspacesByLabels({
    workspaces: byProject.filter(
      (workspace) =>
        (input.showBackground || !workspace.background) &&
        !(
          workspace.serverId === input.activeSelection?.serverId &&
          workspace.workspaceId === input.activeSelection.workspaceId
        ),
    ),
    ...input.labelFilter,
  });
  return resolveAttentionBucket(visible.map((workspace) => workspace.statusBucket));
}
