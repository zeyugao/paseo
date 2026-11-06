import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { resolveAttentionBucket, type AttentionBucket } from "@/utils/attention-indicator";

/** Read only listed tabs; focus and the switcher's open state do not affect attention. */
export function selectWorkspaceTabAttention(
  tabs: readonly WorkspaceTabDescriptor[],
  readBucket: (target: WorkspaceTabDescriptor["target"]) => SidebarStateBucket | null,
): AttentionBucket | null {
  function* buckets() {
    for (const tab of tabs) yield readBucket(tab.target);
  }
  return resolveAttentionBucket(buckets());
}
