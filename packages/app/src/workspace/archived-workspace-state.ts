import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export function purgeArchivedWorkspaceState(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (!workspaceKey) return;
  if (useWorkspaceLayoutStore.persist.hasHydrated()) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
    return;
  }
  const unsubscribe = useWorkspaceLayoutStore.persist.onFinishHydration(() => {
    unsubscribe();
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  });
}
