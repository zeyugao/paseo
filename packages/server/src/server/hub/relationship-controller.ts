import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PRIVATE_FILE_MODE,
  writePrivateFileAtomicSync,
} from "../private-files.js";
import { withReclaimLock } from "../pid-lock.js";
import type { WebSocketLike } from "../websocket-server.js";
import {
  isDaemonPermission,
  parseDaemonPermissions,
  permissionsForLegacyHubScopes,
  type DaemonPermission,
} from "../authorization/index.js";
import type { HubExecutionAgents } from "./daemon-executions.js";
import type {
  HubRelationshipRemote,
  HubSocketConnection,
  HubSocketEvents,
} from "./relationship-remote.js";
import { HubEnrollmentRejectedError } from "./relationship-remote.js";
import { BoundedExponentialHubRetryPolicy } from "./relationship-retry.js";

const FILE_NAME = "hub-relationship.json";
const HUB_CONNECTION_LEASE_FILE_NAME = "hub-connection.lock";
const HUB_CONNECTION_RECLAIM_LOCK_FILE_NAME = "hub-connection.reclaim.lock";
const HUB_CONNECTION_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
export const HUB_CONNECTION_LEASE_STALE_AFTER_MS = 120_000;

const HubConnectionLeaseOwnerSchema = z.object({
  serverId: z.string().min(1),
  hostname: z.string().min(1),
  pid: z.number().int().positive(),
  leaseId: z.string().uuid(),
  acquiredAt: z.string(),
});

export type HubConnectionLeaseOwner = z.infer<typeof HubConnectionLeaseOwnerSchema>;

export class HubConnectionLeaseOwnedError extends Error {
  constructor(public readonly owner: HubConnectionLeaseOwner | null) {
    super(
      owner
        ? `Hub connection is owned by server ${owner.serverId} on ${owner.hostname} (PID ${owner.pid})`
        : "Hub connection lease is not owned by this daemon",
    );
    this.name = "HubConnectionLeaseOwnedError";
  }
}

interface HubConnectionLeaseRegistration {
  assertOwned(): Promise<void>;
  assertOwnedSync(): void;
  release(): Promise<void>;
}

export interface HubConnectionLeaseOptions {
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
}
const HubOriginSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    try {
      normalizeHubUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid Hub URL",
      });
    }
  });

const DaemonPermissionsSchema = z
  .array(z.string())
  .superRefine((permissions, context) => {
    for (const permission of permissions) {
      if (!isDaemonPermission(permission)) {
        context.addIssue({ code: "custom", message: `Invalid daemon permission: ${permission}` });
      }
    }
  })
  .transform(parseDaemonPermissions);
const RelationshipSchema = z.object({
  daemonId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  hubOrigin: HubOriginSchema,
  createdAt: z.string(),
  permissions: DaemonPermissionsSchema,
});
const SanitizedRelationshipSchema = RelationshipSchema.omit({ idempotencyKey: true });
const CredentialSchema = z.object({ secret: z.string().min(1) });
const TransportSchema = z.object({
  kind: z.literal("direct_websocket"),
  webSocketUrl: z
    .string()
    .url()
    .refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol))
    .refine((value) => new URL(value).hash === ""),
});
const PendingSchema = z.object({
  version: z.literal(2),
  state: z.literal("pending"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  enrollment: z.object({ token: z.string().min(1) }),
  identity: z.object({ serverId: z.string().min(1), daemonPublicKey: z.string().min(1) }),
});
const ActiveSchema = z.object({
  version: z.literal(2),
  state: z.literal("active"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  transport: TransportSchema,
});
const DisconnectingSchema = z.object({
  version: z.literal(2),
  state: z.literal("disconnecting"),
  relationship: RelationshipSchema,
  credential: CredentialSchema,
  transport: TransportSchema.optional(),
});
const RevokedSchema = z.object({
  version: z.literal(2),
  state: z.literal("revoked"),
  relationship: SanitizedRelationshipSchema,
  transport: TransportSchema.optional(),
  reason: z.string().optional(),
});
const CurrentRecordSchema = z
  .discriminatedUnion("state", [PendingSchema, ActiveSchema, DisconnectingSchema, RevokedSchema])
  .superRefine((record, context) => {
    if (!("transport" in record) || !record.transport) return;
    const hub = new URL(record.relationship.hubOrigin);
    const socket = new URL(record.transport.webSocketUrl);
    const expectedProtocol = hub.protocol === "https:" ? "wss:" : "ws:";
    if (socket.protocol === expectedProtocol && socket.host === hub.host) return;
    context.addIssue({
      code: "custom",
      path: ["transport", "webSocketUrl"],
      message: "Hub WebSocket URL must match the Hub origin",
    });
  });
const RecordSchema = z.preprocess(migrateLegacyRecord, CurrentRecordSchema);
type PendingRecord = z.infer<typeof PendingSchema>;
type ActiveRecord = z.infer<typeof ActiveSchema>;
type DisconnectingRecord = z.infer<typeof DisconnectingSchema>;
type RevokedRecord = z.infer<typeof RevokedSchema>;
type HubRelationshipRecord = z.infer<typeof RecordSchema>;

export type HubConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "revoked";

export interface HubRelationshipStatus {
  state: HubConnectionState;
  daemonId: string | null;
  hubOrigin: string | null;
  permissions: DaemonPermission[];
  connectedAt: string | null;
  lastError: string | null;
}

export interface HubRelationshipManagement {
  connect(input: {
    hubUrl: string;
    token: string;
    permissions: readonly string[];
  }): Promise<HubRelationshipStatus>;
  updatePermissions(input: {
    grant: readonly string[];
    revoke: readonly string[];
  }): Promise<HubRelationshipStatus>;
  status(): HubRelationshipStatus;
  disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }>;
}

export interface ScheduledRelationshipTask {
  cancel(): void;
}

export interface HubRelationshipClock {
  now(): Date;
  schedule(delayMs: number, task: () => void): ScheduledRelationshipTask;
}

export interface HubRelationshipRetryPolicy {
  delay(attempt: number): number;
}

export interface HubRelationshipControllerOptions {
  paseoHome: string;
  hostname: string;
  serverId: string;
  daemonPublicKey: string;
  logger: pino.Logger;
  remote: HubRelationshipRemote;
  clock?: HubRelationshipClock;
  retryPolicy?: HubRelationshipRetryPolicy;
  createDaemonId?: () => string;
  connectionLease?: HubConnectionLeaseOptions;
  attachSocket: (
    socket: WebSocketLike,
    options: {
      daemonId: string;
      principalId: string;
      permissions: readonly DaemonPermission[];
      agents: HubExecutionAgents;
      sessionProtocol: "legacy" | "session-v1";
    },
  ) => Promise<void>;
  updateAttachedPermissions: (
    principalId: string,
    permissions: readonly DaemonPermission[],
  ) => void;
  createExecutionAgents: (daemonId: string) => HubExecutionAgents;
}

const systemClock: HubRelationshipClock = {
  now: () => new Date(),
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

function normalizeHubUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hub URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Hub URL cannot include credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Hub URL cannot include a query or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export class HubRelationshipController implements HubRelationshipManagement {
  private readonly filePath: string;
  private readonly clock: HubRelationshipClock;
  private readonly retryPolicy: HubRelationshipRetryPolicy;
  private record: HubRelationshipRecord | null = null;
  private state: HubConnectionState = "not_connected";
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private socket: HubSocketConnection | null = null;
  private retry: ScheduledRelationshipTask | null = null;
  private generation = 0;
  private enrollmentGeneration = 0;
  private retryAttempt = 0;
  private readonly inFlightEnrollments = new Set<Promise<void>>();
  private executionAgents: { daemonId: string; value: HubExecutionAgents } | null = null;
  private connectionLease: HubConnectionLeaseRegistration | null = null;
  private blockedLeaseOwner: HubConnectionLeaseOwner | null = null;
  private started = false;
  private leaseAttempt: Promise<void> | null = null;
  private leaseAcquisition: Promise<HubConnectionLeaseRegistration> | null = null;
  private executionRetirement: Promise<void> = Promise.resolve();

  constructor(private readonly options: HubRelationshipControllerOptions) {
    this.filePath = path.join(options.paseoHome, FILE_NAME);
    this.clock = options.clock ?? systemClock;
    this.retryPolicy = options.retryPolicy ?? new BoundedExponentialHubRetryPolicy();
  }

  start(): Promise<void> {
    if (this.started) return this.leaseAttempt ?? Promise.resolve();
    this.started = true;
    this.retryAttempt = 0;
    return this.startWithLease();
  }

  private startWithLease(): Promise<void> {
    if (this.leaseAttempt) return this.leaseAttempt;
    if (!this.started || this.connectionLease) return Promise.resolve();
    const attempt = this.acquireConnectionLease(this.generation);
    this.leaseAttempt = attempt;
    const settled = () => {
      if (this.leaseAttempt === attempt) this.leaseAttempt = null;
    };
    void attempt.then(settled, settled);
    return attempt;
  }

  private async acquireConnectionLease(generation: number): Promise<void> {
    try {
      let lease: HubConnectionLeaseRegistration;
      try {
        lease = await this.registerConnectionLease();
      } catch (error) {
        if (!this.started || generation !== this.generation) return;
        if (!(error instanceof HubConnectionLeaseOwnedError)) throw error;
        this.blockedLeaseOwner = error.owner;
        this.state = "not_connected";
        this.lastError = error.message;
        this.options.logger.warn(
          { owner: error.owner },
          "Hub connection disabled because another daemon owns the per-home lease",
        );
        this.scheduleLeaseAcquisition();
        return;
      }
      if (!this.started || generation !== this.generation) {
        await lease.release();
        return;
      }
      this.connectionLease = lease;
      this.blockedLeaseOwner = null;
      this.retryAttempt = 0;
      await this.executionRetirement;
      if (!this.started || generation !== this.generation) return;
      this.loadRelationshipForStartup();
      if (this.record?.state === "active") await this.openSocket(this.record, false);
      if (this.record?.state === "pending") {
        const enrollmentGeneration = this.beginEnrollmentAttempt();
        try {
          await this.tryEnrollment(this.record, enrollmentGeneration);
        } catch (error) {
          if (!(error instanceof HubEnrollmentRejectedError)) throw error;
          this.options.logger.warn(
            { statusCode: error.statusCode },
            "Discarded rejected pending Hub enrollment during startup",
          );
        }
      }
    } catch (error) {
      if (generation !== this.generation) throw error;
      this.started = false;
      try {
        await this.stopLifecycle();
      } catch (stopError) {
        this.options.logger.error(
          { err: stopError },
          "Failed to clean up Hub connection after startup failure",
        );
      }
      throw error;
    }
  }

  private async registerConnectionLease(): Promise<HubConnectionLeaseRegistration> {
    let lease: HubConnectionLeaseRegistration;
    const acquisition = acquireHubConnectionLease({
      paseoHome: this.options.paseoHome,
      serverId: this.options.serverId,
      hostname: this.options.hostname,
      heartbeatIntervalMs: this.options.connectionLease?.heartbeatIntervalMs,
      staleAfterMs: this.options.connectionLease?.staleAfterMs,
      onLost: (error) => {
        if (this.connectionLease === lease) this.connectionLeaseLost(error);
      },
    });
    this.leaseAcquisition = acquisition;
    try {
      lease = await acquisition;
      return lease;
    } finally {
      if (this.leaseAcquisition === acquisition) this.leaseAcquisition = null;
    }
  }

  private scheduleLeaseAcquisition(): void {
    if (!this.started) return;
    this.schedule(() =>
      this.startWithLease().catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Scheduled Hub lease acquisition failed");
      }),
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    const acquisition = this.leaseAcquisition;
    this.leaseAttempt = null;
    try {
      await this.stopLifecycle();
    } finally {
      const lease = await acquisition?.catch(() => null);
      await lease?.release();
    }
  }

  private async stopLifecycle(): Promise<void> {
    const lease = this.connectionLease;
    this.connectionLease = null;
    this.blockedLeaseOwner = null;
    this.state = "not_connected";
    this.connectedAt = null;
    try {
      const pendingExecutionCleanup = this.retireExecutionAgents();
      this.cancelLifecycle();
      this.socket?.close();
      this.socket = null;
      await pendingExecutionCleanup;
    } finally {
      await lease?.release();
    }
  }

  status(): HubRelationshipStatus {
    return {
      state: this.state,
      daemonId: this.record?.relationship.daemonId ?? null,
      hubOrigin: this.record?.relationship.hubOrigin ?? null,
      permissions: this.record?.relationship.permissions.slice() ?? [],
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  async connect(input: {
    hubUrl: string;
    token: string;
    permissions: readonly string[];
  }): Promise<HubRelationshipStatus> {
    await this.requireConnectionLease();
    const permissions = parseDaemonPermissions(input.permissions);
    if (this.record?.state === "pending") {
      if (normalizeHubUrl(input.hubUrl) !== this.record.relationship.hubOrigin) {
        throw new Error("A pending Hub enrollment already exists for a different Hub");
      }
      this.record = { ...this.record, enrollment: { token: input.token } };
      const enrollmentGeneration = this.beginEnrollmentAttempt();
      this.persist(this.record);
      this.state = "connecting";
      this.lastError = null;
      await this.tryEnrollment(this.record, enrollmentGeneration);
      return this.status();
    }
    if (this.record && this.record.state !== "revoked") {
      throw new Error("This daemon already has a Hub relationship");
    }
    const pending: PendingRecord = {
      version: 2,
      state: "pending",
      relationship: {
        daemonId: this.options.createDaemonId?.() ?? randomUUID(),
        idempotencyKey: randomUUID(),
        hubOrigin: normalizeHubUrl(input.hubUrl),
        createdAt: this.clock.now().toISOString(),
        permissions,
      },
      credential: { secret: randomBytes(32).toString("base64url") },
      enrollment: { token: input.token },
      identity: { serverId: this.options.serverId, daemonPublicKey: this.options.daemonPublicKey },
    };
    this.persist(pending);
    this.record = pending;
    this.state = "connecting";
    this.lastError = null;
    await this.tryEnrollment(pending, this.beginEnrollmentAttempt());
    return this.status();
  }

  async updatePermissions(input: {
    grant: readonly string[];
    revoke: readonly string[];
  }): Promise<HubRelationshipStatus> {
    const lease = this.connectionLease;
    await this.requireConnectionLease(lease);
    if (!this.record || this.record.state !== "active") {
      throw new Error("This daemon is not connected to a Hub");
    }
    const grant = parseDaemonPermissions(input.grant);
    const revoke = parseDaemonPermissions(input.revoke);
    const permissions = parseDaemonPermissions([
      ...this.record.relationship.permissions.filter((permission) => !revoke.includes(permission)),
      ...grant,
    ]);
    const result = await this.options.remote.updatePermissions({
      daemonId: this.record.relationship.daemonId,
      hubOrigin: this.record.relationship.hubOrigin,
      credential: this.record.credential.secret,
      permissions,
    });
    await this.requireConnectionLease(lease);
    if (!samePermissions(result.permissions, permissions)) {
      throw new Error("Hub permission response did not match the local grant");
    }
    this.record = {
      ...this.record,
      relationship: { ...this.record.relationship, permissions },
    };
    this.persist(this.record);
    this.options.updateAttachedPermissions(hubPrincipalId(this.record), permissions);
    return this.status();
  }

  async disconnect(input: {
    force: boolean;
  }): Promise<{ status: HubRelationshipStatus; warning?: string }> {
    const lease = this.connectionLease;
    await this.requireConnectionLease(lease);
    const waitForEnrollment = this.record?.state === "pending";
    const pendingCreateCleanup = this.retireExecutionAgents();
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    if (!this.record || this.record.state === "revoked") {
      this.remove();
      await pendingCreateCleanup;
      return { status: this.status() };
    }
    const disconnecting: DisconnectingRecord = {
      version: 2,
      state: "disconnecting",
      relationship: this.record.relationship,
      credential: this.record.credential,
      ...(this.record.state === "active" ? { transport: this.record.transport } : {}),
    };
    this.persist(disconnecting);
    this.record = disconnecting;
    this.state = "disconnecting";
    if (waitForEnrollment && !input.force) {
      await Promise.all(this.inFlightEnrollments);
    }
    await this.requireConnectionLease(lease);
    let warning: string | undefined;
    if (!input.force) {
      try {
        await this.options.remote.revoke({
          daemonId: disconnecting.relationship.daemonId,
          hubOrigin: disconnecting.relationship.hubOrigin,
          credential: disconnecting.credential.secret,
        });
      } catch (error) {
        this.options.logger.warn(
          { err: error, daemonId: disconnecting.relationship.daemonId },
          "Failed to notify Hub before removing local relationship",
        );
        warning =
          "Hub could not be reached; local relationship removed, but server-side revocation may remain pending.";
      }
    }
    await this.requireConnectionLease(lease);
    this.remove();
    await pendingCreateCleanup;
    return { status: this.status(), ...(warning ? { warning } : {}) };
  }

  private async tryEnrollment(pending: PendingRecord, enrollmentGeneration: number): Promise<void> {
    if (enrollmentGeneration !== this.enrollmentGeneration) return;
    const verifier = createHash("sha256").update(pending.credential.secret).digest("base64url");
    const request = this.requireConnectionLease().then(() => {
      if (enrollmentGeneration !== this.enrollmentGeneration) return null;
      return this.options.remote.enroll({
        daemonId: pending.relationship.daemonId,
        idempotencyKey: pending.relationship.idempotencyKey,
        hubOrigin: pending.relationship.hubOrigin,
        token: pending.enrollment.token,
        hostname: this.options.hostname,
        serverId: pending.identity.serverId,
        daemonPublicKey: pending.identity.daemonPublicKey,
        credentialVerifier: verifier,
        permissions: pending.relationship.permissions,
      });
    });
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    this.inFlightEnrollments.add(settled);
    try {
      const enrollment = await request;
      if (!enrollment || enrollmentGeneration !== this.enrollmentGeneration) return;
      await this.requireConnectionLease();
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      if (
        enrollment.daemonId !== pending.relationship.daemonId ||
        !samePermissions(enrollment.permissions, pending.relationship.permissions)
      ) {
        throw new Error("Hub enrollment response did not match the pending relationship");
      }
      const active: ActiveRecord = {
        version: 2,
        state: "active",
        relationship: pending.relationship,
        credential: pending.credential,
        transport: { kind: "direct_websocket", webSocketUrl: enrollment.webSocketUrl },
      };
      this.persist(active);
      this.record = active;
      this.retry = null;
      this.retryAttempt = 0;
      await this.openSocket(active, false);
    } catch (error) {
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      if (error instanceof HubEnrollmentRejectedError) {
        this.remove();
        throw error;
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleEnrollment(pending, enrollmentGeneration);
    } finally {
      this.inFlightEnrollments.delete(settled);
    }
  }

  private async openSocket(record: ActiveRecord, reconnecting: boolean): Promise<void> {
    const generation = ++this.generation;
    this.state = reconnecting ? "reconnecting" : "connecting";
    try {
      await this.requireConnectionLease();
      if (generation !== this.generation) return;
      this.socket?.close();
      this.socket = null;
      const events: HubSocketEvents = {
        connected: (socket, sessionProtocol) =>
          this.socketConnected(generation, record, socket, sessionProtocol),
        rejected: (statusCode) => this.socketRejected(generation, statusCode),
        closed: (code) => this.socketClosed(generation, record, code),
        failed: (error) => this.socketFailed(generation, record, error),
      };
      this.socket = this.options.remote.openSocket(
        {
          daemonId: record.relationship.daemonId,
          webSocketUrl: record.transport.webSocketUrl,
          credential: record.credential.secret,
        },
        events,
      );
    } catch (error) {
      this.socketFailed(
        generation,
        record,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private socketConnected(
    generation: number,
    record: ActiveRecord,
    socket: WebSocketLike,
    sessionProtocol: "legacy" | "session-v1",
  ): void {
    const lease = this.connectionLease;
    if (!lease || !this.socketAuthorityCurrent(generation, lease)) {
      socket.close();
      return;
    }
    this.retryAttempt = 0;
    this.retry?.cancel();
    this.retry = null;
    this.state = "connected";
    this.connectedAt = this.clock.now().toISOString();
    this.lastError = null;
    void this.options.attachSocket(this.socketWithLeaseAuthority(socket, generation, lease), {
      daemonId: record.relationship.daemonId,
      principalId: hubPrincipalId(record),
      permissions: record.relationship.permissions,
      agents: this.executionAgentsFor(record.relationship.daemonId),
      sessionProtocol,
    });
  }

  private socketAuthorityCurrent(
    generation: number,
    lease: HubConnectionLeaseRegistration | null,
  ): boolean {
    if (generation !== this.generation || !lease || lease !== this.connectionLease) return false;
    try {
      lease.assertOwnedSync();
      return true;
    } catch (error) {
      if (!(error instanceof HubConnectionLeaseOwnedError)) throw error;
      return false;
    }
  }

  private socketWithLeaseAuthority(
    socket: WebSocketLike,
    generation: number,
    lease: HubConnectionLeaseRegistration,
  ): WebSocketLike {
    const isCurrent = () => {
      if (this.socketAuthorityCurrent(generation, lease)) return true;
      socket.close();
      return false;
    };
    return {
      get readyState() {
        return socket.readyState;
      },
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      get maxFrameBytes() {
        return socket.maxFrameBytes;
      },
      send:
        socket.send.length < 2
          ? (data) => {
              if (isCurrent()) return socket.send(data);
            }
          : (data, callback) => {
              if (!isCurrent()) {
                callback?.(new HubConnectionLeaseOwnedError(this.blockedLeaseOwner));
                return;
              }
              return socket.send(data, callback);
            },
      close: (code, reason) => socket.close(code, reason),
      terminate: socket.terminate?.bind(socket),
      on: (event, listener) => {
        socket.on(
          event,
          event === "message"
            ? (...args) => {
                if (isCurrent()) listener(...args);
              }
            : listener,
        );
      },
      once: (event, listener) => socket.once(event, listener),
    };
  }

  private executionAgentsFor(daemonId: string): HubExecutionAgents {
    if (this.executionAgents?.daemonId === daemonId) return this.executionAgents.value;
    const agents = this.options.createExecutionAgents(daemonId);
    const lease = this.connectionLease;
    const requireAuthority = async () => {
      await this.requireConnectionLease(lease);
      if (this.executionAgents?.value !== value) {
        throw new Error("Hub relationship authority is no longer active");
      }
    };
    const value: HubExecutionAgents = {
      create: async (input) => {
        await requireAuthority();
        return agents.create(input);
      },
      control: async (input) => {
        await requireAuthority();
        return agents.control(input);
      },
      subscribe: (listener) => agents.subscribe(listener),
      invalidateAuthority: () => agents.invalidateAuthority(),
    };
    this.executionAgents = { daemonId, value };
    return value;
  }

  private retireExecutionAgents(): Promise<void> {
    const executionAgents = this.executionAgents;
    this.executionAgents = null;
    if (executionAgents) {
      this.executionRetirement = Promise.all([
        this.executionRetirement,
        executionAgents.value.invalidateAuthority(),
      ]).then(() => undefined);
    }
    return this.executionRetirement;
  }

  private socketRejected(generation: number, statusCode: 401 | 403): void {
    if (!this.socketAuthorityCurrent(generation, this.connectionLease)) return;
    this.revoke(`Hub rejected socket authentication (${statusCode})`);
  }

  private socketClosed(generation: number, record: ActiveRecord, code: number): void {
    if (!this.socketAuthorityCurrent(generation, this.connectionLease)) return;
    if (code === 4403) {
      this.revoke("Hub revoked this relationship");
      return;
    }
    if (this.record?.state === "active") this.scheduleSocket(record);
  }

  private socketFailed(generation: number, record: ActiveRecord, error: Error): void {
    if (!this.socketAuthorityCurrent(generation, this.connectionLease)) return;
    this.lastError = error.message;
    if (this.record?.state === "active") this.scheduleSocket(record);
  }

  private scheduleSocket(record: ActiveRecord): void {
    this.state = "reconnecting";
    this.schedule(() => this.openSocket(record, true));
  }

  private scheduleEnrollment(record: PendingRecord, enrollmentGeneration: number): void {
    if (enrollmentGeneration !== this.enrollmentGeneration) return;
    this.state = "reconnecting";
    this.retry?.cancel();
    const delay = this.retryPolicy.delay(this.retryAttempt++);
    this.retry = this.clock.schedule(delay, () => {
      if (enrollmentGeneration !== this.enrollmentGeneration) return;
      this.retry = null;
      return this.tryEnrollment(record, enrollmentGeneration).catch((error: unknown) => {
        if (error instanceof HubEnrollmentRejectedError) return;
        this.options.logger.error({ err: error }, "Scheduled Hub enrollment retry failed");
      });
    });
  }

  private schedule(task: () => void | Promise<void>): void {
    this.retry?.cancel();
    const generation = this.generation;
    const delay = this.retryPolicy.delay(this.retryAttempt++);
    this.retry = this.clock.schedule(delay, () => {
      if (generation !== this.generation) return;
      this.retry = null;
      return task();
    });
  }

  private revoke(reason: string): void {
    void this.retireExecutionAgents();
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    if (!this.record) return;
    const revoked: RevokedRecord = {
      version: 2,
      state: "revoked",
      relationship: {
        daemonId: this.record.relationship.daemonId,
        hubOrigin: this.record.relationship.hubOrigin,
        createdAt: this.record.relationship.createdAt,
        permissions: this.record.relationship.permissions,
      },
      transport: "transport" in this.record ? this.record.transport : undefined,
      reason,
    };
    this.persist(revoked);
    this.record = revoked;
    this.state = "revoked";
    this.lastError = reason;
  }

  private cancelLifecycle(): void {
    ++this.generation;
    ++this.enrollmentGeneration;
    this.retry?.cancel();
    this.retry = null;
  }

  private beginEnrollmentAttempt(): number {
    this.retry?.cancel();
    this.retry = null;
    this.retryAttempt = 0;
    return ++this.enrollmentGeneration;
  }

  private loadRelationshipForStartup(): void {
    this.record = this.load();
    if (this.record?.state === "disconnecting") {
      // COMPAT(hubUnilateralDisconnect): added in v0.4.0, remove after 2027-02-13 once legacy records have aged out.
      this.options.logger.warn(
        { daemonId: this.record.relationship.daemonId },
        "Removed legacy disconnecting Hub relationship during startup",
      );
      rmSync(this.filePath, { force: true });
      this.record = null;
    }
    if (this.record?.state === "revoked") {
      this.state = "revoked";
      this.lastError = this.record.reason ?? null;
    } else {
      this.state = this.record ? "connecting" : "not_connected";
      this.lastError = null;
    }
  }

  private async requireConnectionLease(lease = this.connectionLease): Promise<void> {
    if (!lease || lease !== this.connectionLease) {
      throw new HubConnectionLeaseOwnedError(this.blockedLeaseOwner);
    }
    await lease.assertOwned();
    if (lease !== this.connectionLease) {
      throw new HubConnectionLeaseOwnedError(this.blockedLeaseOwner);
    }
  }

  private connectionLeaseLost(error: HubConnectionLeaseOwnedError): void {
    if (!this.connectionLease) return;
    this.connectionLease = null;
    this.blockedLeaseOwner = null;
    this.lastError = error.message;
    this.state = "not_connected";
    this.connectedAt = null;
    void this.retireExecutionAgents();
    this.cancelLifecycle();
    this.socket?.close();
    this.socket = null;
    this.options.logger.error(
      { err: error, owner: error.owner },
      "Hub connection stopped after losing the per-home lease",
    );
    if (this.record?.state !== "revoked") this.scheduleLeaseAcquisition();
  }

  private persist(record: HubRelationshipRecord): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(record, null, 2)}\n`, {
      preserveSymlink: true,
    });
  }

  private remove(): void {
    void this.retireExecutionAgents();
    this.cancelLifecycle();
    rmSync(this.filePath, { force: true });
    this.record = null;
    this.state = "not_connected";
    this.connectedAt = null;
    this.lastError = null;
  }

  private load(): HubRelationshipRecord | null {
    if (!existsSync(this.filePath)) return null;
    let record: HubRelationshipRecord;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      record = RecordSchema.parse(raw);
      if (isLegacyRecord(raw)) this.persist(record);
    } catch (error) {
      const quarantinePath = path.join(
        path.dirname(this.filePath),
        `hub-relationship.invalid-${this.clock.now().getTime()}-${randomUUID()}.json`,
      );
      renameSync(this.filePath, quarantinePath);
      ensurePrivateFile(quarantinePath);
      this.options.logger.error(
        { err: error, quarantinePath },
        "Quarantined invalid Hub relationship authority",
      );
      return null;
    }
    ensurePrivateFile(this.filePath);
    return record;
  }
}

interface AcquireHubConnectionLeaseInput {
  paseoHome: string;
  serverId: string;
  hostname: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  onLost(error: HubConnectionLeaseOwnedError): void;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireHubConnectionLease(
  input: AcquireHubConnectionLeaseInput,
): Promise<HubConnectionLeaseRegistration> {
  const filePath = path.join(input.paseoHome, HUB_CONNECTION_LEASE_FILE_NAME);
  const reclaimLockPath = path.join(input.paseoHome, HUB_CONNECTION_RECLAIM_LOCK_FILE_NAME);
  const staleAfterMs = input.staleAfterMs ?? HUB_CONNECTION_LEASE_STALE_AFTER_MS;
  const owner: HubConnectionLeaseOwner = {
    serverId: input.serverId,
    hostname: input.hostname,
    pid: process.pid,
    leaseId: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  ensurePrivateDirectory(input.paseoHome);

  await withReclaimLock(reclaimLockPath, async () => {
    const existing = await readHubConnectionLease(filePath);
    if (existing) {
      const fileStat = await stat(filePath);
      const ownerIsDead =
        existing.hostname === input.hostname &&
        existing.serverId === input.serverId &&
        !isPidAlive(existing.pid);
      if (Date.now() - fileStat.mtimeMs <= staleAfterMs && !ownerIsDead) {
        throw new HubConnectionLeaseOwnedError(existing);
      }
      await unlink(filePath);
    } else if (await hubConnectionLeaseFileIsCurrent(filePath, staleAfterMs)) {
      throw new HubConnectionLeaseOwnedError(null);
    } else {
      await unlink(filePath).catch((error: unknown) => {
        if (!isMissingFileError(error)) throw error;
      });
    }
    await writeHubConnectionLease(filePath, owner);
  });

  let released = false;
  let release: Promise<void> | null = null;
  let heartbeatPending = false;
  let lost = false;
  const markLost = (current: HubConnectionLeaseOwner | null): HubConnectionLeaseOwnedError => {
    const error = new HubConnectionLeaseOwnedError(current);
    if (!lost && !released) {
      lost = true;
      clearInterval(timer);
      input.onLost(error);
    }
    return error;
  };
  const assertOwned = async (touch: boolean): Promise<void> => {
    if (lost || released) throw new HubConnectionLeaseOwnedError(null);
    await withReclaimLock(reclaimLockPath, async () => {
      if (lost || released) throw new HubConnectionLeaseOwnedError(null);
      const current = await readHubConnectionLease(filePath);
      if (!sameHubConnectionLease(current, owner)) throw markLost(current);
      if (touch) {
        const now = new Date();
        await utimes(filePath, now, now);
      }
      if (lost || released) throw new HubConnectionLeaseOwnedError(null);
    });
  };
  const heartbeatIntervalMs =
    input.heartbeatIntervalMs ?? HUB_CONNECTION_LEASE_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    if (heartbeatPending || released || lost) return;
    heartbeatPending = true;
    void assertOwned(true)
      .catch(() => {
        if (!lost && !released) markLost(null);
      })
      .finally(() => {
        heartbeatPending = false;
      });
  }, heartbeatIntervalMs);
  timer.unref();

  return {
    assertOwned: () => assertOwned(false),
    assertOwnedSync(): void {
      if (lost || released) throw new HubConnectionLeaseOwnedError(null);
      let current: HubConnectionLeaseOwner | null = null;
      try {
        const parsed = HubConnectionLeaseOwnerSchema.safeParse(
          JSON.parse(readFileSync(filePath, "utf8")),
        );
        current = parsed.success ? parsed.data : null;
      } catch {
        throw markLost(null);
      }
      if (!sameHubConnectionLease(current, owner)) throw markLost(current);
    },
    release(): Promise<void> {
      if (release) return release;
      released = true;
      clearInterval(timer);
      release = withReclaimLock(reclaimLockPath, async () => {
        const current = await readHubConnectionLease(filePath);
        if (sameHubConnectionLease(current, owner)) await unlink(filePath);
      });
      return release;
    },
  };
}

async function readHubConnectionLease(filePath: string): Promise<HubConnectionLeaseOwner | null> {
  try {
    const parsed = HubConnectionLeaseOwnerSchema.safeParse(
      JSON.parse(await readFile(filePath, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function hubConnectionLeaseFileIsCurrent(
  filePath: string,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    return Date.now() - (await stat(filePath)).mtimeMs <= staleAfterMs;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function writeHubConnectionLease(
  filePath: string,
  owner: HubConnectionLeaseOwner,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function sameHubConnectionLease(
  actual: HubConnectionLeaseOwner | null,
  expected: HubConnectionLeaseOwner,
): boolean {
  return actual?.leaseId === expected.leaseId;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function hubPrincipalId(record: ActiveRecord): string {
  const credentialFingerprint = createHash("sha256")
    .update(record.credential.secret)
    .digest("base64url");
  return `hub:${record.relationship.daemonId}:${credentialFingerprint}`;
}

function samePermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((scope) => actual.includes(scope));
}

function isLegacyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

function migrateLegacyRecord(value: unknown): unknown {
  if (!isLegacyRecord(value)) return value;
  const relationship = Reflect.get(value, "relationship");
  if (typeof relationship !== "object" || relationship === null) return value;
  const scopes = Reflect.get(relationship, "scopes");
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return value;
  const { scopes: _legacyScopes, ...relationshipWithoutScopes } = relationship as Record<
    string,
    unknown
  >;
  return {
    ...(value as Record<string, unknown>),
    version: 2,
    relationship: {
      ...relationshipWithoutScopes,
      permissions: permissionsForLegacyHubScopes(scopes),
    },
  };
}
