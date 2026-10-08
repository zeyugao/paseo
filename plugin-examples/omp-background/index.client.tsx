import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { useMemo } from "react";

/**
 * Composer pill for OMP agents that yielded a run to pending background work.
 *
 * The daemon's OMP provider marks the yield with a synthetic timeline row
 * (`callId` below; the state machine lives in the daemon's
 * `providers/omp/background-work.ts`). The pill is pure derivation: this
 * plugin watches each omp agent's timeline, registers a composer pill while
 * that row reads `running`, and removes it when the row turns terminal —
 * which the daemon guarantees on `session_settled`, process exit, and session
 * close, so an omp reload or daemon restart clears the pill too.
 */
const BACKGROUND_WORK_CALL_ID = "omp-background-work";
const SYNC_DEBOUNCE_MS = 250;

interface WatchedAgent {
  id: string;
  workspaceId?: string | null;
}

interface AgentWatchState {
  workspaceId: string | null;
  registration: PluginButtonRegistration | null;
  syncTimer: ReturnType<typeof setTimeout> | undefined;
}

function BackgroundWorkPopover({ theme, layout, close }: PluginButtonContentProps) {
  const styles = useMemo(
    () => ({
      body: { gap: 12, padding: layout.compact ? 16 : 20 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
      action: { color: theme.colors.accent, fontSize: 13 },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.body}>
      <Text style={styles.title}>Background work running</Text>
      <Text style={styles.detail}>
        OMP finished this turn and handed off to a background job. The session wakes by itself when
        the job reports its result. If the OMP process restarts, the pending job is discarded.
      </Text>
      <Pressable accessibilityRole="button" onPress={close}>
        <Text style={styles.action}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  const watchStates = new Map<string, AgentWatchState>();
  const teardowns = new Map<string, () => void>();
  const lifetime = new AbortController();
  let stopped = false;

  const teardown = (agentId: string): void => {
    teardowns.get(agentId)?.();
    teardowns.delete(agentId);
  };

  const watch = (agent: WatchedAgent): void => {
    if (stopped || teardowns.has(agent.id)) return;
    const handle = client.paseo.agents.ref(agent.id);
    const state: AgentWatchState = {
      workspaceId: agent.workspaceId ?? null,
      registration: null,
      syncTimer: undefined,
    };
    watchStates.set(agent.id, state);

    const sync = async (): Promise<void> => {
      if (stopped) return;
      try {
        // One in-memory projected timeline read per debounce window; live
        // events only say "something changed", the row is the truth.
        const page = await handle.timeline.refetch({ limit: 0 });
        if (stopped || watchStates.get(agent.id) !== state) return;
        const item = page.entries.find(
          (entry) =>
            entry.item.type === "tool_call" && entry.item.callId === BACKGROUND_WORK_CALL_ID,
        )?.item;
        const running =
          item !== undefined && item.type === "tool_call" && item.status === "running";
        if (running && state.workspaceId) {
          state.registration ??= client.addComposerPill({
            id: "background-work",
            workspaceId: state.workspaceId,
            agentId: agent.id,
            button: {
              title: "Background work running",
              icon: "Activity",
              label: "Background work",
              behavior: { kind: "popover", Content: BackgroundWorkPopover },
            },
          });
        } else {
          state.registration?.remove();
          state.registration = null;
        }
      } catch (error) {
        if (!stopped) console.error("Background-work timeline sync failed", error);
      }
    };

    const scheduleSync = (): void => {
      clearTimeout(state.syncTimer);
      state.syncTimer = setTimeout(() => {
        state.syncTimer = undefined;
        void sync();
      }, SYNC_DEBOUNCE_MS);
    };

    const unsubscribeAgent = handle.subscribe((update) => {
      if (update.kind === "remove") {
        teardown(agent.id);
        return;
      }
      state.workspaceId = update.agent.workspaceId ?? null;
    });
    const timelineSubscription = handle.timeline.subscribe(() => scheduleSync());

    teardowns.set(agent.id, () => {
      clearTimeout(state.syncTimer);
      unsubscribeAgent();
      timelineSubscription.release();
      state.registration?.remove();
      watchStates.delete(agent.id);
    });
    scheduleSync();
  };

  const syncWatches = (agents: readonly WatchedAgent[]): void => {
    const watchedIds = new Set<string>();
    for (const agent of agents) {
      watchedIds.add(agent.id);
      const state = watchStates.get(agent.id);
      if (state) {
        state.workspaceId = agent.workspaceId ?? null;
        continue;
      }
      watch(agent);
    }
    for (const agentId of teardowns.keys()) {
      if (!watchedIds.has(agentId)) teardown(agentId);
    }
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          syncWatches(
            entries
              .filter((entry) => entry.agent.provider === "omp" && !entry.agent.archivedAt)
              .map((entry) => entry.agent),
          );
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            teardown(update.agentId);
            return;
          }
          if (update.agent.provider !== "omp" || update.agent.archivedAt) {
            teardown(update.agent.id);
            return;
          }
          const state = watchStates.get(update.agent.id);
          if (state) {
            state.workspaceId = update.agent.workspaceId ?? null;
            return;
          }
          watch(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Background-work agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const agentId of teardowns.keys()) teardown(agentId);
  };
}
