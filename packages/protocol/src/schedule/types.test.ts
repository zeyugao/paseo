import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, StoredScheduleSchema } from "./types.js";

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("StoredScheduleSchema", () => {
  const stored = {
    id: "abcdef12",
    name: null,
    prompt: "Run the task",
    cadence: { type: "cron" as const, expression: "0 3 * * *" },
    target: { type: "new-agent" as const, config: { provider: "claude", cwd: "/tmp/project" } },
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
  };

  test("keeps an owning host optional for legacy records", () => {
    expect(StoredScheduleSchema.parse(stored)).not.toHaveProperty("hostId");
  });

  test("preserves the owning host", () => {
    expect(StoredScheduleSchema.parse({ ...stored, hostId: "srv-a" })).toMatchObject({
      hostId: "srv-a",
    });
  });
});
