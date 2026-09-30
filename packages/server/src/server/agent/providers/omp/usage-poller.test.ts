import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import type { AgentUsage } from "../../agent-sdk-types.js";
import type { OmpSessionStats } from "./rpc-types.js";
import { OmpUsagePoller, type OmpUsagePollScheduler } from "./usage-poller.js";

class ManualPollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("No context usage poll is scheduled");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("OMP usage poller", () => {
  test("emits only changed usage while active", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: AgentUsage[] = [];
    let stats: OmpSessionStats = {
      tokens: { input: 100, cacheRead: 10, output: 20 },
      cost: 0.01,
      contextUsage: { contextWindow: 200_000, tokens: 130 },
    };
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: async () => stats,
      onUsage: (update) => updates.push(update),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    await waitForImmediate();
    scheduler.poll();
    await waitForImmediate();
    stats = { ...stats, contextUsage: { contextWindow: 200_000, tokens: 150 } };
    scheduler.poll();
    await waitForImmediate();

    expect(updates).toEqual([
      {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
      {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 150,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("drops an in-flight poll without hiding the final refresh", async () => {
    const scheduler = new ManualPollScheduler();
    const inFlightStats = deferred<OmpSessionStats>();
    const finalStats = { contextUsage: { contextWindow: 200_000, tokens: 150 } };
    const finalUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 150,
    };
    const updates: Array<{ usage: AgentUsage; turnId?: string }> = [];
    let readCount = 0;
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: async () => {
        readCount += 1;
        return readCount === 1 ? inFlightStats.promise : finalStats;
      },
      onUsage: (usage, turnId) => updates.push({ usage, turnId }),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    scheduler.poll();
    await expect(poller.completeTurn("turn-1")).resolves.toBeUndefined();
    inFlightStats.resolve({
      contextUsage: { contextWindow: 200_000, tokens: 130 },
    });
    await waitForImmediate();

    expect(updates).toEqual([{ usage: finalUsage, turnId: "turn-1" }]);
    await expect(poller.completeTurn()).resolves.toBeUndefined();
    expect(updates).toEqual([{ usage: finalUsage, turnId: "turn-1" }]);
  });

  test("drops a final refresh when a newer turn starts", async () => {
    const scheduler = new ManualPollScheduler();
    const finalStats = deferred<OmpSessionStats>();
    const updates: AgentUsage[] = [];
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: () => finalStats.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const completion = poller.completeTurn();
    poller.startTurn();
    finalStats.resolve({ contextUsage: { contextWindow: 200_000, tokens: 150 } });

    await expect(completion).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(1);
    poller.stopTurn();
  });

  test("close permanently suppresses pending usage", async () => {
    const scheduler = new ManualPollScheduler();
    const finalStats = deferred<OmpSessionStats>();
    const updates: AgentUsage[] = [];
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: () => finalStats.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    poller.startTurn();
    const completion = poller.completeTurn();
    poller.close();
    poller.startTurn();
    finalStats.resolve({ contextUsage: { contextWindow: 200_000, tokens: 150 } });

    await expect(completion).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("readOnce publishes usage once without a turn", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: AgentUsage[] = [];
    let stats: OmpSessionStats = {
      tokens: { input: 900, cacheRead: 10, output: 90 },
      cost: 0.5,
      contextUsage: { contextWindow: 200_000, tokens: 130 },
    };
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: async () => stats,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    await poller.readOnce();
    // Empty stats and unchanged stats never re-emit.
    stats = { tokens: { input: 0, cacheRead: 0, output: 0 }, cost: 0 };
    await poller.readOnce();
    stats = {
      tokens: { input: 900, cacheRead: 10, output: 90 },
      cost: 0.5,
      contextUsage: { contextWindow: 200_000, tokens: 130 },
    };
    await poller.readOnce();

    expect(updates).toEqual([
      {
        inputTokens: 900,
        cachedInputTokens: 10,
        outputTokens: 90,
        totalCostUsd: 0.5,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("readOnce drops its read when a turn starts first", async () => {
    const scheduler = new ManualPollScheduler();
    const stats = deferred<OmpSessionStats>();
    const updates: AgentUsage[] = [];
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: () => stats.promise,
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    const initial = poller.readOnce();
    poller.startTurn();
    stats.resolve({ contextUsage: { contextWindow: 200_000, tokens: 130 } });
    await initial;
    await waitForImmediate();

    expect(updates).toEqual([]);
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(updates).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    poller.stopTurn();
  });

  test("readOnce ignores read errors and skips while a turn is active", async () => {
    const scheduler = new ManualPollScheduler();
    const updates: AgentUsage[] = [];
    let stats: OmpSessionStats | Error = new Error("stats unavailable");
    const poller = new OmpUsagePoller({
      scheduler,
      readStats: async () => {
        if (stats instanceof Error) throw stats;
        return stats;
      },
      onUsage: (usage) => updates.push(usage),
      onPollError: (error) => {
        throw error;
      },
    });

    await expect(poller.readOnce()).resolves.toBeUndefined();
    stats = { contextUsage: { contextWindow: 200_000, tokens: 130 } };
    poller.startTurn();
    await poller.readOnce();

    expect(updates).toEqual([]);
    poller.stopTurn();
  });
});
