import type { AgentTimelineItem } from "../../agent-sdk-types.js";

/**
 * The single timeline row that tracks an OMP run yielded to background work.
 *
 * `agent_end` with `awaitingAsyncWork` settles the Paseo turn while an OMP
 * background job is still pending. Without this row the yield is invisible:
 * the agent reads idle and nothing says the session re-wakes on its own when
 * the job result lands.
 *
 * Every transition re-emits the same `callId`, so the timeline projection
 * collapses them into one row. The row is daemon-side only — it is never
 * written to OMP's own history, so a timeline rehydrated from provider history
 * after a daemon restart simply lacks it, and no stale "running" row can
 * survive a reload. While the daemon lives, the row is finalized on
 * `session_settled` (the settle watcher speaks only once nothing queued or
 * background can re-wake the session) and on process exit / session close,
 * where the background jobs die with the OMP process.
 */
export const OMP_BACKGROUND_WORK_CALL_ID = "omp-background-work";

type OmpBackgroundWorkItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
type OmpBackgroundWorkStatus = "running" | "completed" | "canceled";

const BACKGROUND_WORK_LABELS: Record<OmpBackgroundWorkStatus, string> = {
  running: "Background work running",
  completed: "Background work finished",
  canceled: "Background work discarded",
};

export function buildOmpBackgroundWorkItem(
  status: OmpBackgroundWorkStatus,
  text: string,
): OmpBackgroundWorkItem {
  return {
    type: "tool_call",
    callId: OMP_BACKGROUND_WORK_CALL_ID,
    name: "background_work",
    detail: {
      type: "plain_text",
      label: BACKGROUND_WORK_LABELS[status],
      text,
      icon: "bot",
    },
    metadata: { synthetic: true, source: "omp_background_work" },
    status,
    error: null,
  };
}
