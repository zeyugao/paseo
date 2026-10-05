import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { randomUUID } from "node:crypto";
import { open, readFile, readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { startAgentRun, type AgentRunController } from "../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import { withReclaimLock } from "../pid-lock.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;
const SCHEDULE_CLAIM_STALE_MS = 60 * 60 * 1000;

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  if (patch.thinkingOptionId !== undefined) {
    const trimmed = patch.thinkingOptionId?.trim();
    if (trimmed) {
      config.thinkingOptionId = trimmed;
    } else {
      delete config.thinkingOptionId;
    }
  }
  if (patch.archiveOnFinish !== undefined) {
    config.archiveOnFinish = patch.archiveOnFinish;
  }
  if (patch.isolation !== undefined) {
    config.isolation = patch.isolation;
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running").length;
}

function shouldArchiveScheduleRunWorkspace(input: {
  agentId: string | null;
  archiveOnFinish?: boolean;
}): boolean {
  return input.agentId === null || (input.archiveOnFinish ?? true);
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function requireSchedule(schedule: StoredSchedule | null, id: string): StoredSchedule {
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }
  return schedule;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
}

function mergeScheduleCadenceTimezone(
  current: StoredSchedule["cadence"],
  next: StoredSchedule["cadence"],
): StoredSchedule["cadence"] {
  if (
    current.type === "cron" &&
    next.type === "cron" &&
    next.timezone === undefined &&
    current.timezone !== undefined
  ) {
    return {
      ...next,
      timezone: current.timezone,
    };
  }
  return next;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

type ScheduleAgentManager = Pick<
  AgentRunController,
  | "getAgent"
  | "reloadAgentSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "serverId"
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "runAgent"
    | "waitForAgentEvent"
    | "waitForAgentClose"
  >;

interface ScheduleWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

export interface ScheduleServiceOptions {
  paseoHome: string;
  serverId?: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  assertCwdWorkspaceOwnedByThisServer?: (cwd: string) => Promise<void>;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly claimsDir: string;
  private readonly claimsLockPath: string;
  private readonly serverId: string | undefined;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly assertCwdWorkspaceOwnedByThisServer: ((cwd: string) => Promise<void>) | null;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private readonly runningClaims = new Map<string, string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(options: ScheduleServiceOptions) {
    this.logger = options.logger.child({ module: "schedule-service" });
    this.claimsDir = join(options.paseoHome, "schedules");
    this.claimsLockPath = join(this.claimsDir, ".claims.lock");
    this.store = new ScheduleStore(this.claimsDir, this.logger);
    this.serverId = options.serverId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createDirectoryWorkspace = options.createDirectoryWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.archiveWorkspace = options.archiveWorkspace;
    this.assertCwdWorkspaceOwnedByThisServer = options.assertCwdWorkspaceOwnedByThisServer ?? null;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule, runId) => this.executeSchedule(schedule, runId));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
    await this.sweepOrphanedSchedules();
    await this.sweepStaleScheduleClaims();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    await this.assertAgentTargetOwnedByThisHost(input.target);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    return this.store.create(this.buildScheduleRecord(input, fields));
  }

  private buildScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Omit<StoredSchedule, "id"> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return {
      name: fields.name,
      prompt: fields.prompt,
      cadence: input.cadence,
      target: fields.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
    };
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  async createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    await this.assertAgentTargetOwnedByThisHost(input.target);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      create: async () => {
        return this.buildScheduleRecord(input, { name, prompt, target: inputTarget });
      },
      update: async (current) => {
        const now = this.now();
        const cadence = mergeScheduleCadenceTimezone(current.cadence, input.cadence);
        const runOnCreate = input.runOnCreate ?? cadence.type === "every";
        const nextRunAt = runOnCreate ? now : computeNextRunAt(cadence, now);
        return {
          ...current,
          name,
          prompt,
          cadence,
          target: inputTarget,
          status: "active",
          pausedAt: null,
          nextRunAt: nextRunAt.toISOString(),
          expiresAt: input.expiresAt ?? null,
          maxRuns: normalizeMaxRuns(input.maxRuns),
          updatedAt: now.toISOString(),
        };
      },
    });
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    return schedule;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(paused, id);
  }

  async resume(id: string): Promise<StoredSchedule> {
    const resumed = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "active" as const,
        pausedAt: null,
        nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(resumed, id);
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const next = await this.store.update(input.id, async (schedule) => {
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        const cadence = mergeScheduleCadenceTimezone(updated.cadence, input.cadence);
        validateScheduleCadence(cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(cadence, now).toISOString() : null;
        updated = { ...updated, cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        updated = {
          ...updated,
          target: patchedTarget,
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      return { ...updated, updatedAt: now.toISOString() };
    });
    return requireSchedule(next, input.id);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async completeForAgent(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.store.list();
    const matches = schedules.filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    );
    const results = await Promise.allSettled(
      matches.map((schedule) => this.completeScheduleForAgent(schedule.id, agentId, now)),
    );
    let completed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        completed += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          "Failed to complete schedule for archived agent; continuing",
        );
      }
    }
    return completed;
  }

  private async completeScheduleForAgent(
    scheduleId: string,
    agentId: string,
    now: Date,
  ): Promise<boolean> {
    let completed = false;
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.target.type !== "agent" ||
        schedule.target.agentId !== agentId ||
        schedule.status === "completed"
      ) {
        return schedule;
      }
      completed = true;
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
    return completed;
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new Error(`Schedule ${id} is already running`);
    }
    await this.assertAgentTargetOwnedByThisHost(schedule.target);
    if (schedule.target.type === "new-agent" && this.assertCwdWorkspaceOwnedByThisServer) {
      await this.assertCwdWorkspaceOwnedByThisServer(schedule.target.config.cwd);
    }
    const now = this.now();
    const runId = randomUUID();
    const claimPath = await this.tryClaimSchedule(schedule, runId, now, "manual");
    if (this.serverId !== undefined && claimPath === null) {
      throw new Error(`Schedule ${id} is already running on another host`);
    }
    if (claimPath) this.runningClaims.set(id, claimPath);
    try {
      await this.runSchedule(schedule, now, { manual: true }, runId);
    } finally {
      this.runningClaims.delete(id);
      if (claimPath) await this.releaseScheduleClaim(claimPath, runId);
    }
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    const now = this.now();
    await this.renewRunningClaims(now);
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      if (schedule.status !== "active" || !schedule.nextRunAt) continue;
      if (this.runningScheduleIds.has(schedule.id)) continue;
      if (await this.isScheduleTargetOwnedByAnotherHost(schedule)) continue;
      if (shouldCompleteSchedule(schedule, now)) {
        await this.completeScheduleIfDue(schedule.id, now);
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) continue;
      const runId = randomUUID();
      const claimPath = await this.tryClaimSchedule(schedule, runId, now, "due");
      if (this.serverId !== undefined && claimPath === null) continue;
      if (claimPath) this.runningClaims.set(schedule.id, claimPath);
      try {
        const fresh = await this.confirmDueSchedule(schedule);
        if (!fresh) continue;
        await this.runSchedule(fresh, now, undefined, runId);
      } finally {
        this.runningClaims.delete(schedule.id);
        if (claimPath) await this.releaseScheduleClaim(claimPath, runId);
      }
    }
  }

  // A schedule targeting an agent is executed by the host that owns the agent; other
  // hosts sharing PASEO_HOME must not claim, run, or advance it. Legacy agents (no
  // hostId) remain runnable everywhere.
  private async foreignAgentTargetHost(
    schedule: Pick<StoredSchedule, "target">,
  ): Promise<string | null> {
    if (schedule.target.type !== "agent") return null;
    const record = await this.agentStorage.getFresh(schedule.target.agentId);
    const hostId = record?.hostId ?? this.agentManager.getAgent(schedule.target.agentId)?.hostId;
    return hostId !== undefined && hostId !== this.serverId ? hostId : null;
  }

  private async assertAgentTargetOwnedByThisHost(target: ScheduleTarget): Promise<void> {
    const foreignHost = await this.foreignAgentTargetHost({ target });
    if (foreignHost !== null) {
      throw new Error(`agent is owned by host ${foreignHost}`);
    }
  }

  private async isAgentTargetOwnedByAnotherHost(schedule: StoredSchedule): Promise<boolean> {
    return (await this.foreignAgentTargetHost(schedule)) !== null;
  }

  private async isScheduleTargetOwnedByAnotherHost(schedule: StoredSchedule): Promise<boolean> {
    if (await this.isAgentTargetOwnedByAnotherHost(schedule)) return true;
    if (schedule.target.type !== "new-agent" || !this.assertCwdWorkspaceOwnedByThisServer) {
      return false;
    }
    try {
      await this.assertCwdWorkspaceOwnedByThisServer(schedule.target.config.cwd);
      return false;
    } catch {
      return true;
    }
  }

  private async confirmDueSchedule(schedule: StoredSchedule): Promise<StoredSchedule | null> {
    return withReclaimLock(this.claimsLockPath, async () => {
      const current = await this.store.get(schedule.id);
      if (
        !current ||
        current.status !== "active" ||
        current.nextRunAt !== schedule.nextRunAt ||
        new Date(current.nextRunAt ?? "").getTime() > this.now().getTime()
      ) {
        return null;
      }
      return current;
    });
  }

  // Claims are leases: a long run keeps its claim fresh so the stale-claim sweep does
  // not hand the schedule to another host mid-run.
  private async renewRunningClaims(now: Date): Promise<void> {
    if (this.runningClaims.size === 0) {
      return;
    }
    // Renew under the same lock as reclaim: a stale sweep must not observe the old
    // mtime and unlink the claim while a live run is refreshing it.
    await withReclaimLock(this.claimsLockPath, async () => {
      await Promise.all(
        [...this.runningClaims.values()].map(async (claimPath) => {
          try {
            await utimes(claimPath, now, now);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              this.logger.warn({ err: error, claimPath }, "Failed to renew schedule claim");
            }
          }
        }),
      );
    });
  }

  private async tryClaimSchedule(
    schedule: StoredSchedule,
    runId: string,
    now: Date,
    kind: "manual" | "due",
  ): Promise<string | null> {
    if (this.serverId === undefined) return null;
    const claimPath = join(this.claimsDir, `${schedule.id}.claim`);
    return withReclaimLock(this.claimsLockPath, async () => {
      const existing = await stat(claimPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing && now.getTime() - existing.mtimeMs <= SCHEDULE_CLAIM_STALE_MS) return null;
      const abandonedClaim = existing ? await this.readScheduleClaim(claimPath) : null;
      if (existing) {
        await unlink(claimPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      const claimFile = await open(claimPath, "wx", 0o600);
      let claimFailure: unknown;
      try {
        await claimFile.writeFile(
          JSON.stringify({
            runId,
            kind,
            serverId: this.serverId,
            scheduledFor: schedule.nextRunAt ?? now.toISOString(),
            claimedAt: now.toISOString(),
          }),
          "utf8",
        );
      } catch (error) {
        claimFailure = error;
      } finally {
        await claimFile.close().catch((error: unknown) => {
          claimFailure ??= error;
        });
      }
      if (claimFailure !== undefined) {
        // A partially-written claim must not block claiming until the stale
        // sweep; remove it so the next tick can retry.
        await unlink(claimPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        throw claimFailure;
      }
      if (existing) {
        try {
          await this.failAbandonedRunningRuns(schedule.id, abandonedClaim?.runId, now);
        } catch (error) {
          await unlink(claimPath).catch((unlinkError: unknown) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          });
          throw error;
        }
      }
      return claimPath;
    });
  }

  private async failAbandonedRunningRuns(
    scheduleId: string,
    abandonedRunId: unknown,
    now: Date,
  ): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      const runs = schedule.runs.map((run) => {
        if (
          run.status !== "running" ||
          (typeof abandonedRunId === "string" && run.id !== abandonedRunId)
        ) {
          return run;
        }
        return {
          ...run,
          status: "failed" as const,
          endedAt: now.toISOString(),
          error: "Schedule claim became stale before the run completed",
        };
      });
      return runs.some((run, index) => run !== schedule.runs[index])
        ? { ...schedule, runs, lastRunAt: now.toISOString(), updatedAt: now.toISOString() }
        : schedule;
    });
    requireSchedule(updated, scheduleId);
  }

  private async releaseScheduleClaim(claimPath: string, runId: string): Promise<void> {
    try {
      // Read-compare-unlink under the cross-daemon lock: a concurrent stale sweep or
      // reclaim must not delete a claim that was re-created after we read it.
      await withReclaimLock(this.claimsLockPath, async () => {
        const claim = await this.readScheduleClaim(claimPath);
        if (claim && claim.runId !== runId) {
          return;
        }
        // A missing or unreadable claim is a crash leftover: claims are only
        // written under this lock, so nothing legitimate can be mid-write here.
        await unlink(claimPath);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, claimPath }, "Failed to release schedule claim");
      }
    }
  }

  // Returns null when the claim file is missing, empty, or corrupt: an
  // unreadable claim cannot be matched to a live run and is reclaimable.
  private async readScheduleClaim(
    claimPath: string,
  ): Promise<{ runId?: unknown; serverId?: unknown } | null> {
    try {
      return JSON.parse(await readFile(claimPath, "utf8")) as {
        runId?: unknown;
        serverId?: unknown;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.logger.warn({ err: error, claimPath }, "Failed to parse schedule claim; reclaiming");
      return null;
    }
  }

  private async sweepStaleScheduleClaims(): Promise<void> {
    await withReclaimLock(this.claimsLockPath, async () => {
      const entries = await readdir(this.claimsDir, { withFileTypes: true });
      const nowMs = this.now().getTime();
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".claim"))
          .map(async (entry) => {
            const claimPath = join(this.claimsDir, entry.name);
            const claimStat = await stat(claimPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw error;
            });
            if (!claimStat || nowMs - claimStat.mtimeMs <= SCHEDULE_CLAIM_STALE_MS) return;
            await unlink(claimPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
          }),
      );
    });
  }

  private async completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    let shouldForceArchiveInterruptedWorkspace = false;
    await withReclaimLock(this.claimsLockPath, async () => {
      const claimPath = join(this.claimsDir, `${scheduleId}.claim`);
      const claimStat = await stat(claimPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (claimStat) {
        const claim = await this.readScheduleClaim(claimPath);
        const current = await this.store.get(scheduleId);
        const hasMatchingRunningRun =
          claim !== null &&
          current?.runs.some((run) => run.status === "running" && run.id === claim.runId);
        const ownedByThisServer = this.serverId !== undefined && claim?.serverId === this.serverId;
        shouldForceArchiveInterruptedWorkspace = ownedByThisServer;
        const isFresh = now.getTime() - claimStat.mtimeMs <= SCHEDULE_CLAIM_STALE_MS;
        if (isFresh && hasMatchingRunningRun && !ownedByThisServer) {
          return;
        }
        // A claim from this server is a crash leftover even while its lease is
        // fresh. Unmatched, unreadable, and stale claims are also reclaimable.
        await unlink(claimPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      await this.store.update(scheduleId, (current) => {
        let updated = { ...current };
        let dirty = false;

        const runningIndex = updated.runs.findIndex((run) => run.status === "running");
        if (runningIndex !== -1) {
          const runs = [...updated.runs];
          const runningRun = runs[runningIndex];
          if (
            updated.target.type === "new-agent" &&
            runningRun.workspaceId &&
            (shouldForceArchiveInterruptedWorkspace ||
              shouldArchiveScheduleRunWorkspace({
                agentId: runningRun.agentId,
                archiveOnFinish: updated.target.config.archiveOnFinish,
              }))
          ) {
            interruptedWorkspaces.push({
              workspaceId: runningRun.workspaceId,
              agentId: runningRun.agentId,
              runId: runningRun.id,
            });
          }
          runs[runningIndex] = {
            ...runningRun,
            status: "failed",
            endedAt: now.toISOString(),
            error: "Daemon restarted before the scheduled run completed",
          };
          updated = { ...updated, runs };
          dirty = true;
        }

        if (
          updated.status === "active" &&
          updated.nextRunAt &&
          new Date(updated.nextRunAt).getTime() <= now.getTime()
        ) {
          let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
          while (nextRunAt.getTime() <= now.getTime()) {
            nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
          }
          updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
          dirty = true;
        }

        if (dirty) {
          return { ...updated, updatedAt: now.toISOString() };
        }
        return current;
      });
    });
    const interruptedWorkspace = interruptedWorkspaces[0];
    if (!interruptedWorkspace) {
      return;
    }
    try {
      await this.archiveWorkspace(interruptedWorkspace.workspaceId);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          agentId: interruptedWorkspace.agentId,
          workspaceId: interruptedWorkspace.workspaceId,
          scheduleId,
          runId: interruptedWorkspace.runId,
        },
        "Failed to archive interrupted scheduled workspace after daemon restart",
      );
    }
  }

  // Orphaned agent-target schedules (agent deleted while the daemon was down, or
  // archived before completeForAgent existed) can never fire successfully. Complete
  // them on startup so they stop ticking and surface as ended in the UI.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.store.update(scheduleId, async (schedule) => {
      if (schedule.target.type !== "agent" || schedule.status === "completed") {
        return schedule;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record && !record.archivedAt) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
    claimedRunId?: string,
  ): Promise<void> {
    const manual = options?.manual === true;
    this.runningScheduleIds.add(schedule.id);
    try {
      // The tick and runOnce paths claim the run id before calling in.
      const runId = claimedRunId ?? randomUUID();
      const runningRun: ScheduleRun = {
        id: runId,
        scheduledFor: manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString()),
        startedAt: now.toISOString(),
        endedAt: null,
        status: "running",
        agentId: null,
        output: null,
        error: null,
      };
      const scheduleWithRun = await this.appendRunningRun(schedule.id, runningRun);

      try {
        const result = await this.runner(scheduleWithRun, runId);
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "succeeded",
          agentId: result.agentId,
          output: result.output,
          error: null,
          targetGone: false,
          manual,
        });
      } catch (error) {
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "failed",
          agentId: null,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          targetGone: error instanceof ScheduleTargetGoneError,
          manual,
        });
      }
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: runningRun.startedAt,
      runs: [...schedule.runs, runningRun],
    }));
    return requireSchedule(updated, scheduleId);
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    targetGone: boolean;
    manual: boolean;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => {
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              endedAt: now.toISOString(),
              agentId: params.agentId ?? run.agentId,
              output: params.output,
              error: params.error,
            }
          : run,
      );
      let updated: StoredSchedule = {
        ...schedule,
        runs: completedRuns,
        lastRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      if (params.targetGone) {
        // The target is permanently gone; retrying only burns the schedule down to
        // its expiry, so complete it now regardless of manual/scheduled origin.
        updated = completeSchedule(updated, now);
      } else if (updated.status === "completed") {
        // Completed concurrently (e.g. the target agent was archived mid-run);
        // record the run outcome but leave the schedule terminal — don't advance.
      } else if (params.manual) {
        // Manual one-shot runs do not advance the cadence or recompute completion.
      } else if (shouldCompleteSchedule(updated, now)) {
        updated = completeSchedule(updated, now);
      } else if (updated.status === "paused") {
        updated = {
          ...updated,
          nextRunAt: null,
        };
      } else {
        const after = new Date(schedule.nextRunAt ?? now.toISOString());
        let nextRunAt = computeNextRunAt(updated.cadence, after);
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = {
          ...updated,
          nextRunAt: nextRunAt.toISOString(),
        };
      }

      return updated;
    });
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? {
              ...run,
              workspaceId: params.workspaceId,
              agentId: params.agentId,
            }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult> {
    if (schedule.target.type === "agent") {
      const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (!record) {
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} no longer exists`);
      }
      if (record.archivedAt) {
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} is archived`);
      }

      const agent = await ensureAgentLoaded(schedule.target.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (this.agentManager.hasInFlightRun(agent.id)) {
        throw new Error(`Agent ${agent.id} already has an active run`);
      }
      await startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, {
        replaceRunning: true,
        activeTurnBehavior: "steer",
      });
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(resolveScheduledRunFailure(this.agentManager, agent.id));
      }
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: null,
          timelineText: "",
          finalText: waitResult.lastMessage ?? "",
        }),
      };
    }

    const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
    if (!config) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    await this.assertNewAgentCwdDirectory(config.cwd);
    let workspace: PersistedWorkspaceRecord | null = null;
    let agentId: string | null = null;
    try {
      workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId: null,
      });
      const runConfig = { ...config, cwd: workspace.cwd };
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatScheduleProviderModel(runConfig),
        config: buildScheduleAgentConfig(runConfig),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: resolveScheduleAgentTitle(config, schedule.prompt),
        labels: {
          "paseo.schedule-id": schedule.id,
          "paseo.schedule-run": runId,
        },
        mode: config.modeId,
        thinking: config.thinkingOptionId,
        features: config.featureValues,
        unattended: true,
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      const agent = created.snapshot;
      agentId = agent.id;
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId,
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const result = await this.agentManager.runAgent(agent.id, schedule.prompt);
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (result.canceled) {
        throw new Error(`Scheduled agent ${agent.id} was canceled`);
      }
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(resolveScheduledRunFailure(this.agentManager, agent.id));
      }
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: waitResult.lastMessage ?? null,
          timelineText,
          finalText: result.finalText,
        }),
      };
    } finally {
      if (
        workspace &&
        shouldArchiveScheduleRunWorkspace({ agentId, archiveOnFinish: config.archiveOnFinish })
      ) {
        try {
          await this.archiveWorkspace(workspace.workspaceId);
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              agentId,
              workspaceId: workspace.workspaceId,
              scheduleId: schedule.id,
              runId,
            },
            "Failed to archive scheduled workspace after run",
          );
        }
      }
    }
  }

  private async createScheduleRunWorkspace(
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createDirectoryWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private async assertNewAgentCwdDirectory(cwd: string): Promise<void> {
    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }
}

/**
 * A failed turn no longer ends on an assistant message, so the last assistant
 * text in the timeline is stale by definition. The snapshot's lastError is the
 * only place a scheduled run's failure text still reaches the caller.
 */
function resolveScheduledRunFailure(agentManager: ScheduleAgentManager, agentId: string): string {
  const snapshot = agentManager.getAgent(agentId);
  const lastError = snapshot?.lifecycle === "error" ? snapshot.lastError.trim() : "";
  return lastError || `Scheduled agent ${agentId} failed`;
}

function buildScheduleAgentConfig(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    providerOptions: config.providerOptions,
    featureValues: config.featureValues,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveScheduleAgentTitle(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  prompt: string,
): string {
  return (
    resolveCreateAgentTitles({
      configTitle: config.title,
      initialPrompt: prompt,
    }).provisionalTitle ?? ""
  );
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
