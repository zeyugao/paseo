import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type AttentionBucket = "needs_input" | "failed" | "attention";

export const ATTENTION_LABEL_KEYS = {
  needs_input: "sidebar.statusBucket.needsInput",
  failed: "sidebar.statusBucket.failed",
  attention: "sidebar.statusBucket.readyToReview",
} as const;

// Unlike activity badges, hidden-content indicators must not let running work hide unread work.
export function resolveAttentionBucket(
  buckets: Iterable<SidebarStateBucket | null | undefined>,
): AttentionBucket | null {
  let attention: AttentionBucket | null = null;
  for (const bucket of buckets) {
    if (bucket === "needs_input") return bucket;
    if (bucket === "failed" || (bucket === "attention" && attention === null)) {
      attention = bucket;
    }
  }
  return attention;
}
