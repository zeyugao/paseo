import { useReplicaQuery } from "@/data/query";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { resolveAttentionBucket } from "@/utils/attention-indicator";
import { deriveSubagentStatusBucket } from "@/subagents/track-presentation";
import {
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { buildTerminalsQueryKey } from "./terminals/state";
import { selectWorkspaceTabAttention } from "./workspace-tab-attention";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

export function useWorkspaceTabAttention(
  tabs: readonly WorkspaceTabDescriptor[],
  serverId: string,
  workspaceId: string,
) {
  const agentAttention = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return selectWorkspaceTabAttention(tabs, (target) => {
      if (target.kind !== "agent") return null;
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId);
      if (!agent?.status) return null;
      return deriveSidebarStateBucket({
        status: selectAgentTurnPresentation(session, target.agentId).isActive
          ? "running"
          : agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention ?? false,
        attentionReason: agent.attentionReason ?? null,
      });
    });
  });
  const subagentAttention = useProviderSubagentStore((state) =>
    selectWorkspaceTabAttention(tabs, (target) => {
      if (target.kind !== "provider_subagent") return null;
      const descriptor = state.descriptors.get(
        providerSubagentKey(serverId, target.parentAgentId, target.subagentId),
      );
      return descriptor
        ? deriveSubagentStatusBucket(providerSubagentLifecycleStatus(descriptor.status))
        : null;
    }),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const hasTerminal = tabs.some((tab) => tab.target.kind === "terminal");
  const terminals = useReplicaQuery({
    queryKey: buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId || null),
    enabled: Boolean(hasTerminal && client && workspaceDirectory),
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({
      enabled: Boolean(hasTerminal && client && workspaceDirectory),
      serverId,
      cwd: workspaceDirectory ?? "",
      workspaceId: workspaceId || undefined,
    }),
    queryFn: async (): Promise<ListTerminalsResponse["payload"]> => {
      if (!client || !workspaceDirectory) throw new Error("Workspace directory not found");
      return client.listTerminals(workspaceDirectory, undefined, {
        workspaceId: workspaceId || undefined,
      });
    },
    select: (data: ListTerminalsResponse["payload"]) =>
      selectWorkspaceTabAttention(tabs, (target) =>
        target.kind === "terminal"
          ? deriveTerminalActivityStatusBucket(
              data.terminals.find((terminal) => terminal.id === target.terminalId)?.activity,
            )
          : null,
      ),
  });
  return resolveAttentionBucket([agentAttention, subagentAttention, terminals.data]);
}
