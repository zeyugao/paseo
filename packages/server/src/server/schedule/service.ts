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
import { ScheduleStore, type StoredSchedule } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import { foldFeatureValues } from "../agent/option-controls.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;
const SCHEDULE_CLAIM_STALE_MS = 60 * 60 * 1000;
const SCHEDULE_CLAIM_RENEW_INTERVAL_MS = 30_000;

interface ScheduleReservation {
  runId: string;
  generation: number;
  claimPath: string | null;
  lost: boolean;
  committed: boolean;
}

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleOwnershipError extends Error {
  constructor(id: string, hostId: string) {
    super(`Schedule ${id} is owned by host ${hostId}`);
    this.name = "ScheduleOwnershipError";
  }
}

export class ScheduleStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleStateConflictError";
  }
}

function advanceNextRunAtPast(
  cadence: StoredSchedule["cadence"],
  nextRunAt: Date,
  now: Date,
): Date {
  let next = nextRunAt;
  while (next.getTime() <= now.getTime()) {
    next = computeNextRunAt(cadence, next);
  }
  return next;
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
    throw new ScheduleNotFoundError(id);
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
  | "reloadStalePluginSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "createAgentFromRecord"
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
  /** Infers the single host owning workspace records overlapping a cwd. */
  resolveCwdWorkspaceHost?: (cwd: string) => Promise<string | null>;
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
  private readonly resolveCwdWorkspaceHost: ((cwd: string) => Promise<string | null>) | null;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly reservations = new Map<string, ScheduleReservation>();
  private readonly runningClaims = new Map<string, ScheduleReservation>();
  private readonly tasks = new Set<Promise<void>>();
  private tickTimer: NodeJS.Timeout | undefined;
  private renewalTimer: NodeJS.Timeout | undefined;
  private dispatchPass: Promise<Promise<void>[]> | null = null;
  private renewalPass: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private stopped = false;
  private generation = 0;
  private acquisition = new AbortController();
  private renewalAcquisition = new AbortController();
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
    this.resolveCwdWorkspaceHost = options.resolveCwdWorkspaceHost ?? null;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule, runId) => this.executeSchedule(schedule, runId));
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (
      this.stopped &&
      (this.startup || this.tasks.size > 0 || this.dispatchPass || this.renewalPass)
    ) {
      return this.stop().then(() => this.start());
    }
    if (this.startup) return this.startup;
    if (this.stopped) {
      this.stopped = false;
      this.generation += 1;
      this.acquisition = new AbortController();
      this.renewalAcquisition = new AbortController();
    }
    const generation = this.generation;
    const startup = this.initialize(generation);
    this.startup = startup;
    return startup;
  }

  private async initialize(generation: number): Promise<void> {
    try {
      await this.recoverInterruptedRuns();
      if (this.stopped || generation !== this.generation) return;
      await this.sweepStaleScheduleClaims();
      if (this.stopped || generation !== this.generation) return;
      await this.reconcileScheduleOwnership();
      if (this.stopped || generation !== this.generation) return;
      await this.sweepOrphanedSchedules();
      if (this.stopped || generation !== this.generation) return;
      this.tickTimer = setInterval(() => {
        if (this.dispatchPass || this.stopped) return;
        void this.beginDispatchPass().catch((error) => {
          this.logger.error({ err: error }, "Failed to process schedule tick");
        });
      }, SCHEDULE_TICK_INTERVAL_MS);
      this.tickTimer.unref();
      this.ensureRenewalTimer();
    } catch (error) {
      if (!this.acquisition.signal.aborted) throw error;
    }
  }

  stopScheduling(): void {
    this.stopped = true;
    this.acquisition.abort();
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  stop(): Promise<void> {
    this.stopScheduling();
    if (this.stopping) return this.stopping;
    const stopping = this.drain();
    this.stopping = stopping;
    return stopping;
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([this.startup, this.dispatchPass]);
    await Promise.allSettled(this.tasks);
    clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
    this.renewalAcquisition.abort();
    await Promise.allSettled([this.renewalPass]);
    this.startup = null;
    this.stopping = null;
  }

  private ensureRenewalTimer(): void {
    if (this.renewalTimer || this.stopped) return;
    this.renewalTimer = setInterval(() => {
      if (this.renewalPass) return;
      void this.beginRenewalPass().catch((error) => {
        this.logger.warn({ err: error }, "Failed to renew schedule claims");
      });
    }, SCHEDULE_CLAIM_RENEW_INTERVAL_MS);
    this.renewalTimer.unref();
  }

  // Ownership follows the target. A legacy record is adopted when its agent or cwd
  // identifies exactly one host; a new-agent record is reassigned when its cwd's
  // sole owning host has changed. Ambiguous host-less records keep the legacy
  // shared/claim-based behavior, ambiguous owned records keep their owner, and a
  // live claim is left alone until its run finishes.
  private async reconcileScheduleOwnership(): Promise<void> {
    if (this.serverId === undefined) return;
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      if (this.stopped) return;
      await withReclaimLock(
        this.claimsLockPath,
        async () => {
          if (this.stopped) return;
          const claimStat = await stat(join(this.claimsDir, `${schedule.id}.claim`)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (!claimStat) await this.reconcileScheduleOwnershipFor(schedule.id);
        },
        { signal: this.acquisition.signal },
      );
    }
  }

  private async inferScheduleOwner(schedule: StoredSchedule): Promise<string | null> {
    if (schedule.target.type === "agent") {
      return (
        (await this.agentStorage.getFresh(schedule.target.agentId))?.hostId ??
        this.agentManager.getAgent(schedule.target.agentId)?.hostId ??
        null
      );
    }
    return this.resolveCwdWorkspaceHost
      ? this.resolveCwdWorkspaceHost(schedule.target.config.cwd)
      : null;
  }

  private async reconcileScheduleOwnershipFor(scheduleId: string): Promise<void> {
    if (this.serverId === undefined) return;
    try {
      const schedule = await this.store.get(scheduleId);
      if (!schedule) return;
      const hostId = await this.inferScheduleOwner(schedule);
      if (hostId === null || hostId === schedule.hostId) return;
      await this.store.update(scheduleId, (current) =>
        current.hostId === schedule.hostId ? { ...current, hostId } : current,
      );
    } catch (error) {
      this.logger.warn(
        { err: error, scheduleId },
        "Failed to reconcile schedule host ownership after run",
      );
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    await this.assertScheduleTargetOwnedByThisHost(input.target);
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
      hostId: this.serverId,
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
    await this.assertScheduleTargetOwnedByThisHost(input.target);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      hostId: this.serverId,
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
          hostId: current.hostId ?? this.serverId,
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
    const schedules = await this.store.list();
    if (this.serverId === undefined) return schedules;
    return schedules.filter(
      (schedule) => schedule.hostId === undefined || schedule.hostId === this.serverId,
    );
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    return requireSchedule(schedule, id);
  }

  private assertOwnedByThisServer(schedule: Pick<StoredSchedule, "id" | "hostId">): void {
    const foreignHost = this.foreignScheduleHost(schedule);
    if (foreignHost !== null) {
      throw new ScheduleOwnershipError(schedule.id, foreignHost);
    }
  }

  private foreignScheduleHost(schedule: Pick<StoredSchedule, "hostId">): string | null {
    if (
      this.serverId === undefined ||
      schedule.hostId === undefined ||
      schedule.hostId === this.serverId
    ) {
      return null;
    }
    return schedule.hostId;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      this.assertOwnedByThisServer(schedule);
      if (schedule.status === "completed") {
        throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
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
      this.assertOwnedByThisServer(schedule);
      if (schedule.status === "completed") {
        throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
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
      this.assertOwnedByThisServer(schedule);
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
        if (input.newAgentConfig.cwd !== undefined && this.assertCwdWorkspaceOwnedByThisServer) {
          await this.assertCwdWorkspaceOwnedByThisServer(patchedTarget.config.cwd);
        }
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
    await withReclaimLock(this.claimsLockPath, async () => {
      await this.store.delete(id, (schedule) => {
        if (schedule) this.assertOwnedByThisServer(schedule);
      });
    });
  }

  async completeForAgent(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.list();
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
    if (this.stopped) throw new ScheduleStateConflictError("Scheduler is stopping");
    const reservation = this.reserve(id);
    if (!reservation) {
      throw new ScheduleStateConflictError(`Schedule ${id} is already running`);
    }
    await this.trackTask(this.runManualSchedule(id, reservation));
    return this.inspect(id);
  }

  private async runManualSchedule(id: string, reservation: ScheduleReservation): Promise<void> {
    const tasks = await this.admitSchedule(id, reservation, "manual");
    await Promise.all(tasks);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const renewal = this.beginRenewalPass();
    // Only the caller starting a pass waits for its newly dispatched executions.
    // Timer ticks use the short pass directly and never retain execution waiters.
    const dispatch = this.dispatchPass ? null : this.beginDispatchPass();
    const [tasks] = await Promise.all([dispatch ?? Promise.resolve([]), renewal]);
    await Promise.all(tasks);
  }

  private reserve(id: string): ScheduleReservation | null {
    if (this.stopped || this.reservations.has(id)) return null;
    const reservation: ScheduleReservation = {
      runId: randomUUID(),
      generation: this.generation,
      claimPath: null,
      lost: false,
      committed: false,
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  private trackTask(task: Promise<void>): Promise<void> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  private beginDispatchPass(): Promise<Promise<void>[]> {
    const pass = this.dispatchSchedules();
    this.dispatchPass = pass;
    void pass.then(
      () => {
        if (this.dispatchPass === pass) this.dispatchPass = null;
        return;
      },
      () => {
        if (this.dispatchPass === pass) this.dispatchPass = null;
      },
    );
    return pass;
  }

  private async dispatchSchedules(): Promise<Promise<void>[]> {
    if (this.startup) await this.startup;
    if (this.stopped) return [];
    const schedules = await this.list();
    const now = this.now();
    const tasks: Promise<void>[] = [];
    for (const schedule of schedules) {
      if (this.stopped) break;
      if (schedule.status !== "active" || !schedule.nextRunAt) continue;
      const due = new Date(schedule.nextRunAt).getTime() <= now.getTime();
      if (!due && !shouldCompleteSchedule(schedule, now)) continue;
      const reservation = this.reserve(schedule.id);
      if (!reservation) continue;
      const admitted = await this.admitSchedule(
        schedule.id,
        reservation,
        "due",
        schedule.nextRunAt,
      );
      tasks.push(...admitted);
    }
    return tasks;
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

  private async assertScheduleTargetOwnedByThisHost(target: ScheduleTarget): Promise<void> {
    await this.assertAgentTargetOwnedByThisHost(target);
    if (target.type === "new-agent" && this.assertCwdWorkspaceOwnedByThisServer) {
      await this.assertCwdWorkspaceOwnedByThisServer(target.config.cwd);
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

  private beginRenewalPass(): Promise<void> {
    if (this.renewalPass) return this.renewalPass;
    const pass = this.renewRunningClaims();
    this.renewalPass = pass;
    void pass.then(
      () => {
        if (this.renewalPass === pass) this.renewalPass = null;
        return;
      },
      () => {
        if (this.renewalPass === pass) this.renewalPass = null;
      },
    );
    return pass;
  }

  private async renewRunningClaims(): Promise<void> {
    if (this.runningClaims.size === 0) return;
    await withReclaimLock(
      this.claimsLockPath,
      async () => {
        for (const [id, reservation] of this.runningClaims) {
          if (!(await this.ownsClaim(id, reservation))) continue;
          const claimPath = reservation.claimPath;
          if (!claimPath) continue;
          const now = this.now();
          try {
            // A stale lease with the same identity can still renew before takeover.
            await utimes(claimPath, now, now);
          } catch (error) {
            reservation.lost = true;
            this.logger.warn({ err: error, claimPath }, "Failed to renew schedule claim");
          }
        }
      },
      { signal: this.renewalAcquisition.signal },
    );
  }

  private async ownsClaim(id: string, reservation: ScheduleReservation): Promise<boolean> {
    const current = this.reservations.get(id);
    if (current !== reservation || reservation.generation !== this.generation || reservation.lost) {
      return false;
    }
    if (reservation.claimPath === null) return this.serverId === undefined;
    const claim = await this.readScheduleClaim(reservation.claimPath);
    if (claim?.runId === reservation.runId && claim.serverId === this.serverId) return true;
    reservation.lost = true;
    return false;
  }

  private assertExecutionAllowed(id: string, runId: string): ScheduleReservation {
    const reservation = this.reservations.get(id);
    const unavailable =
      !reservation ||
      reservation.runId !== runId ||
      reservation.lost ||
      reservation.generation !== this.generation;
    if (this.stopped || unavailable) {
      throw new ScheduleStateConflictError("Scheduled run stopped or lost its claim");
    }
    return reservation;
  }

  private async prepareRun(
    id: string,
    reservation: ScheduleReservation,
    kind: "manual" | "due",
    expectedNextRunAt?: string,
  ): Promise<StoredSchedule | null> {
    if (this.startup) await this.startup;
    return withReclaimLock(
      this.claimsLockPath,
      async () => {
        this.assertExecutionAllowed(id, reservation.runId);
        const schedule = await this.store.get(id);
        if (!schedule) {
          if (kind === "manual") throw new ScheduleNotFoundError(id);
          return null;
        }
        if (kind === "manual") {
          this.assertOwnedByThisServer(schedule);
          if (schedule.status === "completed") {
            throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
          }
          await this.assertScheduleTargetOwnedByThisHost(schedule.target);
        } else {
          if (this.foreignScheduleHost(schedule) !== null) return null;
          if (schedule.status !== "active" || schedule.nextRunAt !== expectedNextRunAt) return null;
          if (await this.isScheduleTargetOwnedByAnotherHost(schedule)) return null;
        }
        this.assertExecutionAllowed(id, reservation.runId);
        const now = this.now();
        if (kind === "due" && shouldCompleteSchedule(schedule, now)) {
          await this.completeScheduleIfDue(id, now);
          return null;
        }
        if (kind === "due" && (!schedule.nextRunAt || new Date(schedule.nextRunAt) > now))
          return null;
        if (!(await this.claimScheduleLocked(schedule, reservation, now, kind))) {
          if (kind === "manual")
            throw new Error(`Schedule ${id} is already running on another host`);
          return null;
        }
        try {
          this.assertExecutionAllowed(id, reservation.runId);
          if (kind === "due") {
            const claimed = await this.claimDueRun(id, reservation.runId, schedule.nextRunAt);
            reservation.committed = claimed !== null;
            return claimed;
          }
          const appended = await this.appendRunningRun(id, {
            id: reservation.runId,
            scheduledFor: now.toISOString(),
            startedAt: now.toISOString(),
            endedAt: null,
            status: "running",
            agentId: null,
            output: null,
            error: null,
          });
          reservation.committed = true;
          return appended;
        } catch (error) {
          if (reservation.claimPath) {
            await this.removeClaimLocked(reservation.claimPath, reservation.runId);
            reservation.claimPath = null;
          }
          throw error;
        }
      },
      { signal: this.acquisition.signal },
    );
  }

  private async claimScheduleLocked(
    schedule: StoredSchedule,
    reservation: ScheduleReservation,
    now: Date,
    kind: "manual" | "due",
  ): Promise<boolean> {
    if (this.serverId === undefined) return true;
    const claimPath = join(this.claimsDir, `${schedule.id}.claim`);
    const existing = await stat(claimPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && now.getTime() - existing.mtimeMs <= SCHEDULE_CLAIM_STALE_MS) return false;
    if (existing) {
      const abandonedClaim = await this.readScheduleClaim(claimPath);
      await this.failAbandonedRunningRuns(schedule.id, abandonedClaim?.runId, now);
      await unlink(claimPath);
    }
    this.assertExecutionAllowed(schedule.id, reservation.runId);
    const claimFile = await open(claimPath, "wx", 0o600);
    try {
      try {
        await claimFile.writeFile(
          JSON.stringify({
            runId: reservation.runId,
            kind,
            serverId: this.serverId,
            scheduledFor: schedule.nextRunAt ?? now.toISOString(),
            claimedAt: now.toISOString(),
          }),
          "utf8",
        );
      } finally {
        await claimFile.close();
      }
    } catch (error) {
      await unlink(claimPath);
      throw error;
    }
    reservation.claimPath = claimPath;
    this.runningClaims.set(schedule.id, reservation);
    this.ensureRenewalTimer();
    return true;
  }

  private async failAbandonedRunningRuns(
    scheduleId: string,
    abandonedRunId: unknown,
    now: Date,
  ): Promise<void> {
    await this.store.update(scheduleId, (schedule) => {
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
  }

  private async removeClaimLocked(claimPath: string, runId: string): Promise<void> {
    const claim = await this.readScheduleClaim(claimPath);
    if (claim?.runId !== runId || claim.serverId !== this.serverId) return;
    await unlink(claimPath);
  }

  // Returns null when the claim file is missing, empty, or corrupt: an
  // unreadable claim cannot be matched to a live run and is reclaimable.
  private async readScheduleClaim(
    claimPath: string,
  ): Promise<{ runId?: unknown; serverId?: unknown } | null> {
    try {
      const claim: unknown = JSON.parse(await readFile(claimPath, "utf8"));
      if (claim === null || typeof claim !== "object" || !("runId" in claim)) return null;
      return {
        runId: claim.runId,
        serverId: "serverId" in claim ? claim.serverId : undefined,
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
    await withReclaimLock(
      this.claimsLockPath,
      async () => {
        if (this.stopped) return;
        const entries = await readdir(this.claimsDir, { withFileTypes: true });
        const now = this.now();
        const nowMs = now.getTime();
        for (const entry of entries) {
          if (this.stopped) return;
          if (!entry.isFile() || !entry.name.endsWith(".claim")) continue;
          const claimPath = join(this.claimsDir, entry.name);
          const claimStat = await stat(claimPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (!claimStat || nowMs - claimStat.mtimeMs <= SCHEDULE_CLAIM_STALE_MS) continue;
          const claim = await this.readScheduleClaim(claimPath);
          const scheduleId = entry.name.slice(0, -".claim".length);
          if (this.reservations.get(scheduleId)?.committed) continue;
          try {
            await this.failAbandonedRunningRuns(scheduleId, claim?.runId, now);
          } catch (error) {
            this.logger.warn(
              { err: error, claimPath, scheduleId },
              "Failed to fail an abandoned schedule run while sweeping a stale claim",
            );
            continue;
          }
          await unlink(claimPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      },
      { signal: this.acquisition.signal },
    );
  }

  private async completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (this.stopped || this.foreignScheduleHost(schedule) !== null) return schedule;
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
    const schedules = await this.list();
    for (const schedule of schedules) {
      if (this.stopped) return;
      await this.recoverInterruptedSchedule(schedule.id);
    }
  }

  private async recoverInterruptedSchedule(scheduleId: string): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    let shouldForceArchiveInterruptedWorkspace = false;
    await withReclaimLock(
      this.claimsLockPath,
      async () => {
        if (this.stopped || this.reservations.get(scheduleId)?.committed) return;
        const now = this.now();
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
          const ownedByThisServer =
            this.serverId !== undefined && claim?.serverId === this.serverId;
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
            if (shouldCompleteSchedule(updated, now)) {
              updated = completeSchedule(updated, now);
            }
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
      },
      { signal: this.acquisition.signal },
    );
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
    const schedules = await this.list();
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

  private async admitSchedule(
    id: string,
    reservation: ScheduleReservation,
    kind: "manual" | "due",
    expectedNextRunAt?: string,
  ): Promise<Promise<void>[]> {
    try {
      const schedule = await this.prepareRun(id, reservation, kind, expectedNextRunAt);
      if (!schedule) {
        await this.releaseReservation(id, reservation);
        return [];
      }
      const task = this.trackTask(this.runSchedule(schedule, reservation, kind === "manual"));
      void task.catch((error) => {
        this.logger.error({ err: error, scheduleId: id }, "Scheduled run failed");
      });
      return [task];
    } catch (error) {
      await this.releaseReservation(id, reservation);
      if (kind === "due" && this.stopped) return [];
      throw error;
    }
  }

  private async releaseReservation(id: string, reservation: ScheduleReservation): Promise<void> {
    try {
      if (!reservation.committed && !reservation.claimPath) return;
      await withReclaimLock(this.claimsLockPath, async () => {
        if (!(await this.ownsClaim(id, reservation))) return;
        if (reservation.claimPath) {
          await this.removeClaimLocked(reservation.claimPath, reservation.runId);
        }
        await this.reconcileScheduleOwnershipFor(id);
      });
    } finally {
      if (this.runningClaims.get(id) === reservation) this.runningClaims.delete(id);
      if (this.reservations.get(id) === reservation) this.reservations.delete(id);
      if (this.runningClaims.size === 0 && !this.startup) {
        clearInterval(this.renewalTimer);
        this.renewalTimer = undefined;
      }
    }
  }

  private async runSchedule(
    schedule: StoredSchedule,
    reservation: ScheduleReservation,
    manual: boolean,
  ): Promise<void> {
    const runId = reservation.runId;
    try {
      let result: ScheduleExecutionResult;
      try {
        await this.assertRunCanDispatch(schedule.id, runId);
        this.assertExecutionAllowed(schedule.id, runId);
        result = await this.runner(schedule, runId);
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
        return;
      }
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
    } finally {
      await this.releaseReservation(schedule.id, reservation);
    }
  }

  // Claims the due slot and advances its cursor in the same serialized update.
  // A tick can hold a stale list while another tick finishes this schedule, and
  // a claim whose outcome write later fails must not re-fire the same slot.
  private async claimDueRun(
    scheduleId: string,
    runId: string,
    expectedNextRunAt: string | null,
  ): Promise<StoredSchedule | null> {
    let claimed: StoredSchedule | null = null;
    await this.store.update(scheduleId, async (schedule) => {
      this.assertExecutionAllowed(scheduleId, runId);
      if (this.foreignScheduleHost(schedule) !== null) return schedule;
      if (schedule.nextRunAt !== expectedNextRunAt) return schedule;
      if (await this.isScheduleTargetOwnedByAnotherHost(schedule)) return schedule;
      this.assertExecutionAllowed(scheduleId, runId);
      const now = this.now();
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        shouldCompleteSchedule(schedule, now) ||
        new Date(schedule.nextRunAt).getTime() > now.getTime()
      ) {
        return schedule;
      }

      const scheduledFor = schedule.nextRunAt;
      const isFinalRun =
        schedule.maxRuns !== null && countCompletedRuns(schedule) + 1 >= schedule.maxRuns;
      const nextRunAt = isFinalRun
        ? null
        : advanceNextRunAtPast(
            schedule.cadence,
            computeNextRunAt(schedule.cadence, new Date(scheduledFor)),
            now,
          ).toISOString();

      const runningRun: ScheduleRun = {
        id: runId,
        scheduledFor,
        startedAt: now.toISOString(),
        endedAt: null,
        status: "running",
        agentId: null,
        output: null,
        error: null,
      };
      const updated: StoredSchedule = {
        ...schedule,
        nextRunAt,
        updatedAt: now.toISOString(),
        runs: [...schedule.runs, runningRun],
      };
      claimed = updated;
      return updated;
    });
    return claimed;
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, async (schedule) => {
      this.assertOwnedByThisServer(schedule);
      if (schedule.status === "completed") {
        throw new ScheduleStateConflictError(`Schedule ${scheduleId} is already completed`);
      }
      await this.assertScheduleTargetOwnedByThisHost(schedule.target);
      this.assertExecutionAllowed(scheduleId, runningRun.id);
      return {
        ...schedule,
        updatedAt: runningRun.startedAt,
        runs: [...schedule.runs, runningRun],
      };
    });
    if (!updated) throw new ScheduleNotFoundError(scheduleId);
    const foreignHost = this.foreignScheduleHost(updated);
    if (foreignHost !== null) throw new ScheduleOwnershipError(scheduleId, foreignHost);
    return updated;
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
    await this.mutateRun(params.scheduleId, params.runId, (schedule) => {
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
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
        // A final slot has no successor until its run limit is raised or cleared.
        // Every runner invocation has a recorded run with this id.
        const finishedRun = completedRuns.find((run) => run.id === params.runId)!;
        const nextRunAt = updated.nextRunAt
          ? new Date(updated.nextRunAt)
          : computeNextRunAt(updated.cadence, new Date(finishedRun.scheduledFor));
        // Move an overdue cursor past a long run without advancing a future one twice.
        updated = {
          ...updated,
          nextRunAt: advanceNextRunAtPast(updated.cadence, nextRunAt, now).toISOString(),
        };
      }

      return updated;
    });
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const recorded = await this.mutateRun(params.scheduleId, params.runId, (schedule) => ({
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
    if (!recorded) throw new ScheduleStateConflictError("Scheduled run lost its claim");
  }

  private async mutateRun(
    scheduleId: string,
    runId: string,
    update: (schedule: StoredSchedule) => StoredSchedule,
  ): Promise<boolean> {
    return withReclaimLock(this.claimsLockPath, async () => {
      const reservation = this.reservations.get(scheduleId);
      if (!reservation || reservation.runId !== runId || !reservation.committed) return false;
      if (!(await this.ownsClaim(scheduleId, reservation))) return false;
      let written = false;
      await this.store.update(scheduleId, (schedule) => {
        if (!schedule.runs.some((run) => run.id === runId && run.status === "running"))
          return schedule;
        written = true;
        return update(schedule);
      });
      return written;
    });
  }

  private async assertRunCanDispatch(scheduleId: string, runId: string): Promise<void> {
    const reservation = this.assertExecutionAllowed(scheduleId, runId);
    await withReclaimLock(
      this.claimsLockPath,
      async () => {
        if (!(await this.ownsClaim(scheduleId, reservation))) {
          throw new ScheduleStateConflictError("Scheduled run lost its claim");
        }
        const schedule = await this.store.get(scheduleId);
        if (!schedule?.runs.some((run) => run.id === runId && run.status === "running")) {
          throw new ScheduleStateConflictError("Scheduled run is no longer running");
        }
        this.assertExecutionAllowed(scheduleId, runId);
      },
      { signal: this.acquisition.signal },
    );
    this.assertExecutionAllowed(scheduleId, runId);
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
      await this.assertRunCanDispatch(schedule.id, runId);
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
      if (waitResult.status === "closed") throw new Error(`Scheduled agent ${agent.id} was closed`);
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
      await this.assertRunCanDispatch(schedule.id, runId);
      workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId: null,
      });
      await this.assertRunCanDispatch(schedule.id, runId);
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
      await this.assertRunCanDispatch(schedule.id, runId);
      const result = await this.agentManager.runAgent(agent.id, schedule.prompt);
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (waitResult.status === "closed") throw new Error(`Scheduled agent ${agent.id} was closed`);
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

// The last assistant message can include partial model output before the failure.
// lastError is the provider failure, including its code and diagnostic.
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
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
    providerOptions: foldFeatureValues(config).providerOptions,
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
