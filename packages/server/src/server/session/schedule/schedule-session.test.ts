import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { ScheduleService } from "../../schedule/service.js";
import { StoredScheduleSchema } from "../../schedule/store.js";
import { ScheduleSession } from "./schedule-session.js";

test("schedule RPC summaries and full records never expose persisted host ownership", async () => {
  const schedule = StoredScheduleSchema.parse({
    id: "schedule-1",
    hostId: "srv-private",
    name: "owned",
    prompt: "Continue working",
    cadence: { type: "every", everyMs: 300000 },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:05:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
  });
  const emitted: SessionOutboundMessage[] = [];
  const session = new ScheduleSession({
    host: {
      emit: (message) => {
        emitted.push(message);
      },
    },
    scheduleService: {
      list: async () => [schedule],
      inspect: async () => schedule,
      runOnce: async () => schedule,
      update: async () => schedule,
    } as unknown as ScheduleService,
    logger: createTestLogger(),
  });
  await session.handleScheduleListRequest({ type: "schedule/list", requestId: "list" });
  await session.handleScheduleInspectRequest({
    type: "schedule/inspect",
    requestId: "inspect",
    scheduleId: schedule.id,
  });
  await session.handleScheduleRunOnceRequest({
    type: "schedule/run-once",
    requestId: "run",
    scheduleId: schedule.id,
  });
  await session.handleScheduleUpdateRequest({
    type: "schedule/update",
    requestId: "update",
    scheduleId: schedule.id,
    name: "owned",
  });
  expect(emitted.map((message) => message.type)).toEqual([
    "schedule/list/response",
    "schedule/inspect/response",
    "schedule/run-once/response",
    "schedule/update/response",
  ]);
  expect(JSON.stringify(emitted)).not.toContain("hostId");
  expect(schedule.hostId).toBe("srv-private");
});
