// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { useReadingPositionRestore } from "./use-reading-position-restore";
import type { SavedReadingPosition } from "./reading-position";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

afterEach(() => vi.restoreAllMocks());

const saved: SavedReadingPosition = {
  agentId: "agent",
  epoch: "epoch",
  seq: 8,
  rowId: "old-row",
  viewOffset: -83,
  expandedTurnHostIds: ["turn"],
  expandedUserMessageIds: [],
  toolCallExpansion: { calls: {}, groups: [] },
};
function row(id: string): StreamItem {
  return {
    id,
    kind: "user_message",
    text: id,
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: 8 },
  };
}
function createWrapper() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

it("waits for the saved row and freezes placement after it mounts", () => {
  const save = vi.fn();
  const persistence = { initial: saved, save };
  const initialProps: { tail: StreamItem[] } = { tail: [] };
  const { result, rerender } = renderHook(
    ({ tail }: { tail: StreamItem[] }) =>
      useReadingPositionRestore({
        agentId: "agent",
        serverId: "host",
        epoch: "epoch",
        isActive: true,
        isAuthoritativeHistoryReady: false,
        tail,
        head: [],
        replacements: new Map(),
        persistence,
      }),
    { wrapper: createWrapper(), initialProps },
  );
  expect(result.current.pending).toBe(true);
  rerender({ tail: [row("old-row")] });
  expect(result.current.position).toMatchObject({ rowId: "old-row", viewOffset: -83 });
  rerender({ tail: [row("new-row")] });
  expect(result.current.pending).toBe(false);
  expect(result.current.position?.rowId).toBe("old-row");
  expect(save).not.toHaveBeenCalled();
  act(() => result.current.cancel());
  expect(result.current.position).toBeNull();
  expect(save).toHaveBeenCalledWith(null);
});

it("restores the replacement host when a saved row is folded", () => {
  const { result } = renderHook(
    () =>
      useReadingPositionRestore({
        agentId: "agent",
        serverId: "host",
        epoch: "epoch",
        isActive: true,
        isAuthoritativeHistoryReady: true,
        tail: [row("turn")],
        head: [],
        replacements: { get: (id) => (id === saved.rowId ? "turn" : undefined) },
        persistence: { initial: saved, save: vi.fn() },
      }),
    { wrapper: createWrapper() },
  );
  expect(result.current.position).toMatchObject({ rowId: "turn", viewOffset: 0 });
});

it("discards a different authoritative epoch instead of seeking a stale row", () => {
  const save = vi.fn();
  const { result } = renderHook(
    () =>
      useReadingPositionRestore({
        agentId: "agent",
        serverId: "host",
        epoch: "rewound",
        isActive: true,
        isAuthoritativeHistoryReady: true,
        tail: [row("old-row")],
        head: [],
        replacements: new Map(),
        persistence: { initial: saved, save },
      }),
    { wrapper: createWrapper() },
  );
  expect(result.current.pending).toBe(false);
  expect(result.current.position).toBeNull();
  expect(save).toHaveBeenCalledWith(null);
});

it("preserves an unloaded anchor on seek failure and clears a removed row only after a successful retry", async () => {
  const fetch = vi
    .spyOn(getHostRuntimeStore(), "fetchAgentTimeline")
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce({
      requestId: "seek",
      agentId: "agent",
      agent: null,
      direction: "before",
      projection: "projected",
      epoch: "epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 0, maxSeq: 10, nextSeq: 11 },
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      hasNewer: false,
      entries: [],
      error: null,
    });
  const save = vi.fn();
  const { result } = renderHook(
    () =>
      useReadingPositionRestore({
        agentId: "agent",
        serverId: "host",
        epoch: "epoch",
        isActive: true,
        isAuthoritativeHistoryReady: true,
        tail: [],
        head: [],
        replacements: new Map(),
        persistence: { initial: saved, save },
      }),
    { wrapper: createWrapper() },
  );
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.pending).toBe(true);
  expect(save).not.toHaveBeenCalled();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.position).toBeNull();
  expect(save).toHaveBeenCalledWith(null);
  expect(fetch).toHaveBeenCalledTimes(2);
});
