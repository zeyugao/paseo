import { expect, test } from "vitest";
import type {
  FetchAgentTimelineOptions,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import { fetchAgentTimelineOnce } from "./fetch-agent-timeline-once";

const page: FetchAgentTimelinePayload = {
  requestId: "request",
  agentId: "agent",
  agent: null,
  direction: "tail",
  projection: "projected",
  epoch: "epoch",
  reset: false,
  staleCursor: false,
  gap: false,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  entries: [],
  error: null,
};

test("concurrent identical timeline reads share one request and await every owner's merge", async () => {
  const response = Promise.withResolvers<void>();
  const merge = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const events: string[] = [];
  let calls = 0;
  const client = {
    async fetchAgentTimeline(_agentId: string, options: FetchAgentTimelineOptions = {}) {
      calls++;
      await response.promise;
      await options.onResponse?.(page);
      events.push("receipt");
      return page;
    },
  };
  const first = fetchAgentTimelineOnce(client, "agent", {
    direction: "tail",
    onResponse: async () => {
      events.push("first");
      entered.resolve();
      await merge.promise;
      events.push("merged");
    },
  });
  const second = fetchAgentTimelineOnce(client, "agent", {
    direction: "tail",
    onResponse: () => {
      events.push("second");
    },
  });
  expect(second).toBe(first);
  response.resolve();
  await entered.promise;
  expect(calls).toBe(1);
  expect(events).toEqual(["first", "second"]);
  merge.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "second", "merged", "receipt"]);
});

test("one failed merge does not receipt before other owners settle", async () => {
  const response = Promise.withResolvers<void>();
  const merge = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const events: string[] = [];
  const client = {
    async fetchAgentTimeline(_agentId: string, options: FetchAgentTimelineOptions = {}) {
      await response.promise;
      try {
        await options.onResponse?.(page);
      } finally {
        events.push("receipt");
      }
      return page;
    },
  };
  const first = fetchAgentTimelineOnce(client, "agent", {
    onResponse: () => {
      throw new Error("merge failed");
    },
  });
  const second = fetchAgentTimelineOnce(client, "agent", {
    onResponse: async () => {
      entered.resolve();
      await merge.promise;
      events.push("merged");
    },
  });
  const rejected = expect(first).rejects.toThrow("merge failed");
  expect(second).toBe(first);
  response.resolve();
  await entered.promise;
  expect(events).toEqual([]);
  merge.resolve();
  await rejected;
  expect(events).toEqual(["merged", "receipt"]);
});

test("a reader arriving after merging begins owns a separate delivery", async () => {
  const entered = Promise.withResolvers<void>();
  const merge = Promise.withResolvers<void>();
  let calls = 0;
  const client = {
    async fetchAgentTimeline(_agentId: string, options: FetchAgentTimelineOptions = {}) {
      calls++;
      await Promise.resolve();
      await options.onResponse?.(page);
      return page;
    },
  };
  const first = fetchAgentTimelineOnce(client, "agent", {
    onResponse: async () => {
      entered.resolve();
      await merge.promise;
    },
  });
  await entered.promise;
  const second = fetchAgentTimelineOnce(client, "agent", {});
  expect(second).not.toBe(first);
  expect(calls).toBe(2);
  merge.resolve();
  await Promise.all([first, second]);
});
