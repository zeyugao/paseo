import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { ReadingRowReplacements } from "./reading-anchor";
import type { ReadingPositionPersistence, SavedReadingPosition } from "./reading-position";

export function useReadingPositionRestore(input: {
  agentId: string;
  serverId: string;
  epoch: string | null;
  isAuthoritativeHistoryReady: boolean;
  isActive: boolean;
  tail: StreamItem[];
  head: StreamItem[];
  replacements: ReadingRowReplacements;
  persistence?: ReadingPositionPersistence;
}) {
  const saved = input.persistence?.initial ?? null;
  const [resolution, setResolution] = useState<{ position: SavedReadingPosition | null } | null>(
    () => (saved?.agentId === input.agentId ? null : { position: null }),
  );
  const candidate = useMemo(() => {
    if (
      resolution !== null ||
      !saved ||
      saved.agentId !== input.agentId ||
      (input.epoch !== null && saved.epoch !== input.epoch)
    )
      return null;
    const replacement = input.replacements.get(saved.rowId);
    const rowId = replacement ?? saved.rowId;
    const row =
      input.tail.find((item) => item.id === rowId) ?? input.head.find((item) => item.id === rowId);
    return row ? { ...saved, rowId, viewOffset: replacement ? 0 : saved.viewOffset } : null;
  }, [resolution, saved, input.agentId, input.epoch, input.tail, input.head, input.replacements]);
  const { mutate, status, reset } = useMutation({
    mutationFn: async () => {
      if (!saved) return;
      await getHostRuntimeStore().fetchAgentTimeline(
        input.serverId,
        input.agentId,
        planTimelinePromptJump({ epoch: saved.epoch, seq: saved.seq }),
      );
    },
  });
  const epochChanged = saved !== null && input.epoch !== null && input.epoch !== saved.epoch;
  const ready = useMemo(() => {
    if (resolution !== null) return resolution;
    if (candidate) return { position: candidate };
    if (input.isAuthoritativeHistoryReady && (epochChanged || status === "success"))
      return { position: null };
    return null;
  }, [resolution, candidate, input.isAuthoritativeHistoryReady, epochChanged, status]);

  useEffect(() => {
    if (resolution !== null || ready === null) return;
    setResolution(ready);
    if (ready.position === null) input.persistence?.save(null);
  }, [resolution, ready, input.persistence]);
  useEffect(() => {
    if (
      ready !== null ||
      !input.isActive ||
      !input.isAuthoritativeHistoryReady ||
      input.epoch === null ||
      status !== "idle"
    )
      return;
    mutate();
  }, [ready, input.isActive, input.isAuthoritativeHistoryReady, input.epoch, status, mutate]);
  const cancel = useCallback(() => {
    setResolution((current) => (current?.position === null ? current : { position: null }));
    input.persistence?.save(null);
  }, [input.persistence]);

  return {
    position: ready?.position ?? null,
    pending: ready === null,
    failed: ready === null && status === "error",
    retry: reset,
    cancel,
  };
}
