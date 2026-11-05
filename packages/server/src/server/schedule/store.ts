import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  StoredScheduleSchema as ProtocolStoredScheduleSchema,
  type ScheduleTarget,
} from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Ownership is persisted locally, never part of the public schedule protocol.
export const StoredScheduleSchema = ProtocolStoredScheduleSchema.extend({
  hostId: z.string().optional(),
});
export type StoredSchedule = z.infer<typeof StoredScheduleSchema>;

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

type ScheduleUpdater = (schedule: StoredSchedule) => StoredSchedule | Promise<StoredSchedule>;

interface ScheduleNameTargetUpsert {
  create: () => Omit<StoredSchedule, "id"> | Promise<Omit<StoredSchedule, "id">>;
  update: ScheduleUpdater;
  /**
   * When set, only records this host owns and legacy host-less records are
   * candidates. A schedule owned by another daemon is never rewritten.
   */
  hostId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return value;
}

function normalizeScheduleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Schedule name is required");
  }
  return trimmed;
}

function normalizeOptionalScheduleName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const trimmed = name.trim();
  return trimmed ? trimmed : null;
}

function targetIdentity(target: ScheduleTarget): unknown {
  if (target.type === "agent") {
    return {
      type: target.type,
      agentId: target.agentId,
    };
  }

  return {
    type: target.type,
    config: target.config,
  };
}

function nameTargetIdentityKey(name: string, target: ScheduleTarget): string {
  return JSON.stringify(
    canonicalize({
      name: normalizeScheduleName(name),
      target: targetIdentity(target),
    }),
  );
}

function matchesNameAndTarget(
  schedule: StoredSchedule,
  name: string,
  target: ScheduleTarget,
  hostId?: string,
): boolean {
  if (hostId !== undefined && schedule.hostId !== undefined && schedule.hostId !== hostId) {
    return false;
  }
  const scheduleName = normalizeOptionalScheduleName(schedule.name);
  return (
    schedule.status !== "completed" &&
    scheduleName !== null &&
    scheduleName === normalizeScheduleName(name) &&
    nameTargetIdentityKey(scheduleName, schedule.target) === nameTargetIdentityKey(name, target)
  );
}

function parseStoredSchedule(
  content: string,
): { success: true; data: StoredSchedule } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return StoredScheduleSchema.safeParse(json);
}

export class ScheduleStore {
  private readonly scheduleMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // The service lists schedules on every tick, so a file that is not a valid schedule is
  // reported when it first appears rather than once per second.
  async list(): Promise<StoredSchedule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(this.dir, entry.name);
          return { filePath, parsed: parseStoredSchedule(await readFile(filePath, "utf-8")) };
        }),
    );
    const schedules: StoredSchedule[] = [];
    const invalidFiles = new Set<string>();
    for (const { filePath, parsed } of files) {
      if (parsed.success) {
        schedules.push(parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, "Skipping invalid schedule file");
      }
    }
    this.reportedInvalidFiles = invalidFiles;
    return schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredScheduleSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created = StoredScheduleSchema.parse({ ...schedule, id: generateScheduleId() });
    await this.write(created);
    return created;
  }

  async update(id: string, updater: ScheduleUpdater): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next === current) {
        return current;
      }
      const owned =
        next.hostId === undefined && current.hostId !== undefined
          ? { ...next, hostId: current.hostId }
          : next;
      if (owned.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const updated = StoredScheduleSchema.parse(owned);
      await this.write(updated);
      return updated;
    });
  }

  async upsertByNameAndTarget(
    name: string,
    target: ScheduleTarget,
    options: ScheduleNameTargetUpsert,
  ): Promise<StoredSchedule> {
    const identity = nameTargetIdentityKey(name, target);
    return this.serializeIdentityMutation(identity, async () => {
      while (true) {
        const existing = (await this.list()).find((schedule) =>
          matchesNameAndTarget(schedule, name, target, options.hostId),
        );
        if (!existing) {
          const created = StoredScheduleSchema.parse({
            ...(await options.create()),
            id: generateScheduleId(),
          });
          if (!matchesNameAndTarget(created, name, target, options.hostId)) {
            throw new Error("Created schedule does not match requested identity");
          }
          await this.write(created);
          return created;
        }

        const updated = await this.updateMatchedSchedule(
          existing.id,
          name,
          target,
          options.update,
          options.hostId,
        );
        if (updated) {
          return updated;
        }
      }
    });
  }

  private async write(schedule: StoredSchedule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(schedule.id), schedule);
  }

  async delete(
    id: string,
    beforeDelete?: (schedule: StoredSchedule | null) => void,
  ): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      beforeDelete?.(await this.get(id));
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  private async serializeScheduleMutation<T>(
    scheduleId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.scheduleMutations, scheduleId, mutation);
  }

  private async serializeIdentityMutation<T>(
    identity: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.identityMutations, identity, mutation);
  }

  private async serializeMutation<T>(
    promises: Map<string, Promise<unknown>>,
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = promises.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    promises.set(key, next);
    try {
      return await next;
    } finally {
      if (promises.get(key) === next) {
        promises.delete(key);
      }
    }
  }

  private async updateMatchedSchedule(
    id: string,
    name: string,
    target: ScheduleTarget,
    updater: ScheduleUpdater,
    hostId?: string,
  ): Promise<StoredSchedule | null> {
    return this.serializeScheduleMutation(id, async () => {
      const current = await this.get(id);
      if (!current || !matchesNameAndTarget(current, name, target, hostId)) {
        return null;
      }
      const next = await updater(current);
      if (next.id !== id) {
        throw new Error(`Schedule update cannot change id: ${id}`);
      }
      const owned =
        next.hostId === undefined && current.hostId !== undefined
          ? { ...next, hostId: current.hostId }
          : next;
      const updated = StoredScheduleSchema.parse(owned);
      if (!matchesNameAndTarget(updated, name, target, hostId)) {
        throw new Error("Updated schedule does not match requested identity");
      }
      await this.write(updated);
      return updated;
    });
  }
}
