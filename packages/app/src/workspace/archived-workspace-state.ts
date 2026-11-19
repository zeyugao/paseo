import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

function purgeWorkspaceLayout(workspaceKey: string): void {
  // Recovery still needs an explicit navigation request after its archived layout is removed.
  useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey, { preservePendingOpen: true });
}

export function purgeArchivedWorkspaceState(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (!workspaceKey) return;
  if (useWorkspaceLayoutStore.persist.hasHydrated()) {
    purgeWorkspaceLayout(workspaceKey);
    return;
  }
  const unsubscribe = useWorkspaceLayoutStore.persist.onFinishHydration(() => {
    unsubscribe();
    purgeWorkspaceLayout(workspaceKey);
  });
}
