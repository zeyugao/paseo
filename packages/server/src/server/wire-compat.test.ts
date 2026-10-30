import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  sendBoundedPhysicalFrameAndWait,
} from "./websocket/physical-socket.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { createAgentMessageDeliveryStub } from "./test-utils/session-stubs.js";
import {
  createMessageReceiptsStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";
import pino from "pino";
import { z } from "zod";
import { describe, expect, test, vi } from "vitest";

import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import {
  AgentTimelineItemPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  ProviderSubagentTimelineResponseMessageSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { Session, type SessionOptions } from "./session.js";
import { WorkspaceSetupObservation } from "./workspace-setup-observation.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { AgentTimelineRow } from "./agent/agent-manager.js";
import { InMemoryAgentTimelineStore } from "./agent/agent-timeline-store.js";
import type { AgentTimelineFetchOptions } from "./agent/agent-timeline-store-types.js";
import { handleCreatePaseoWorktreeRequest } from "./worktree-session.js";
import { createPersistedProjectRecord } from "./workspace-registry.js";

const LegacyTimelineEntryPayloadSchema = z.object({
  provider: z.enum(["claude", "codex", "opencode"]),
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(
    z.object({
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    }),
  ),
  // Copied from v0.1.65-beta.3: no reasoning_merge on the wire yet.
  collapsed: z.array(z.enum(["assistant_merge", "tool_lifecycle"])),
});

const LegacyFetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_response"),
  payload: FetchAgentTimelineResponseMessageSchema.shape.payload.extend({
    entries: z.array(LegacyTimelineEntryPayloadSchema),
  }),
});

class InMemoryAgentManager {
  private readonly timeline = new InMemoryAgentTimelineStore();
  private readonly subagentTimeline = new InMemoryAgentTimelineStore();

  constructor(rows: AgentTimelineRow[]) {
    this.timeline.initialize("agent-1", {
      epoch: "epoch-1",
      rows,
      nextSeq: (rows.at(-1)?.seq ?? 0) + 1,
    });
    this.subagentTimeline.initialize("subagent-1", {
      epoch: "subagent-epoch-1",
      rows,
      nextSeq: (rows.at(-1)?.seq ?? 0) + 1,
    });
  }

  getAgent() {
    return {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      lastUserMessageAt: null,
      lifecycle: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      },
      config: { provider: "codex", cwd: "/tmp/project" },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: null,
      historyPrimed: true,
      lastUsage: undefined,
      lastError: undefined,
      attention: { requiresAttention: false, attentionReason: null, attentionTimestamp: null },
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      session: null,
      activeForegroundTurnId: null,
      labels: {},
    };
  }

  fetchTimeline(_agentId: string, options?: AgentTimelineFetchOptions) {
    return this.timeline.fetch("agent-1", options);
  }

  async waitForAgentClose() {}

  getProviderSubagent() {
    return { provider: "codex" as const };
  }

  fetchProviderSubagentTimeline(
    _agentId: string,
    _subagentId: string,
    options?: AgentTimelineFetchOptions,
  ) {
    return this.subagentTimeline.fetch("subagent-1", options);
  }

  listAgents() {
    return [];
  }

  subscribe() {
    return () => {};
  }
}

class EmptyAgentStorage {
  async list() {
    return [];
  }

  async get() {
    return null;
  }
}

class EmptyProjectRegistry {
  async list() {
    return [];
  }

  async get() {
    return null;
  }

  async upsert() {}
  async archive() {}
  async remove() {}
  async initialize() {}
  async existsOnDisk() {
    return false;
  }
}

class EmptyWorkspaceRegistry {
  get() {
    return null;
  }

  list() {
    return [];
  }
}

class EmptyDaemonConfigStore {
  get() {
    return {
      mcp: { injectIntoAgents: false },
      providers: {},
    };
  }

  onChange() {
    return () => {};
  }
}

class InMemoryWorktreeWorkflow {
  readonly capturedInputs: unknown[] = [];

  async create(input: unknown) {
    this.capturedInputs.push(input);
    return {} as never;
  }
}

function createSessionForWireCompatTest(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  directorySync?: DirectorySyncService;
  messages?: SessionOutboundMessage[];
  manager?: InMemoryAgentManager;
  onMessageToSource?: SessionOptions["onMessageToSource"];
  rows?: AgentTimelineRow[];
  workspaceRegistry?: SessionOptions["workspaceRegistry"];
}): Session {
  const messages = options?.messages ?? [];
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-05-02T00:00:00.000Z",
      item: { type: "reasoning", text: "Step " },
    },
    {
      seq: 2,
      timestamp: "2026-05-02T00:00:00.100Z",
      item: { type: "reasoning", text: "by step" },
    },
    {
      seq: 3,
      timestamp: "2026-05-02T00:00:00.200Z",
      item: { type: "assistant_message", text: "done" },
    },
  ];

  const session = new Session({
    workspaceRuntimeStore: createWorkspaceRuntimeStore(),
    messageReceipts: createMessageReceiptsStub(),
    agentMessages: createAgentMessageDeliveryStub(),
    creationService: createTestCreationService(),
    clientId: "wire-compat-client",
    permissions: OWNER_PERMISSIONS,
    clientCapabilities: options?.clientCapabilities ?? null,
    onMessage: (message) => messages.push(message),
    onMessageToSource:
      options?.onMessageToSource ??
      ((_source, message) => {
        messages.push(message);
      }),
    logger: pino({ level: "silent" }),
    downloadTokenStore: {} as SessionOptions["downloadTokenStore"],
    pushNotifications: {} as SessionOptions["pushNotifications"],
    paseoHome: "/tmp/paseo-home",
    agentManager: (options?.manager ??
      new InMemoryAgentManager(options?.rows ?? rows)) as unknown as SessionOptions["agentManager"],
    agentStorage: new EmptyAgentStorage() as unknown as SessionOptions["agentStorage"],
    projectRegistry: new EmptyProjectRegistry() as unknown as SessionOptions["projectRegistry"],
    workspaceRegistry:
      options?.workspaceRegistry ??
      (new EmptyWorkspaceRegistry() as unknown as SessionOptions["workspaceRegistry"]),
    directorySync: options?.directorySync,
    scheduleService: {} as SessionOptions["scheduleService"],
    checkoutDiffManager: {
      scheduleRefreshForCwd() {},
      onWorkspaceStateMayHaveChanged() {},
    } as unknown as SessionOptions["checkoutDiffManager"],
    github: {
      invalidate() {},
      async searchIssuesAndPrs() {
        return [];
      },
      async createPullRequest() {
        return null;
      },
    } as unknown as SessionOptions["github"],
    workspaceGitService: {
      async getCheckoutDiff() {
        return null;
      },
      async getSnapshot() {
        return null;
      },
      async suggestBranchesForCwd() {
        return [];
      },
      async listStashes() {
        return [];
      },

      async validateBranchRef() {
        return { ok: false, error: "not found" };
      },
      async hasLocalBranch() {
        return false;
      },
      async resolveRepoRemoteUrl() {
        return null;
      },
      async getProjectSlug() {
        return "project";
      },
    } as unknown as SessionOptions["workspaceGitService"],
    daemonConfigStore:
      new EmptyDaemonConfigStore() as unknown as SessionOptions["daemonConfigStore"],
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });

  session.updateClientCapabilities(options?.clientCapabilities ?? null, {});
  return session;
}

async function emitTimelineResponse(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  rows?: AgentTimelineRow[];
  request?: Partial<
    Extract<z.infer<typeof SessionInboundMessageSchema>, { type: "fetch_agent_timeline_request" }>
  >;
}): Promise<Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>> {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({
    clientCapabilities: options?.clientCapabilities,
    rows: options?.rows,
    messages,
  });
  await session.handleMessage({
    type: "fetch_agent_timeline_request",
    requestId: "req-timeline",
    agentId: "agent-1",
    projection: "projected",
    ...options?.request,
  });

  const response = messages[0];
  expect(response?.type).toBe("fetch_agent_timeline_response");
  if (!response || response.type !== "fetch_agent_timeline_response") {
    throw new Error("Expected fetch_agent_timeline_response");
  }
  return response;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("timeline request source scheduling", () => {
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-05-02T00:00:00.000Z",
      item: { type: "user_message", text: "first prompt" },
    },
    {
      seq: 2,
      timestamp: "2026-05-02T00:00:01.000Z",
      item: { type: "assistant_message", text: "first answer" },
    },
    {
      seq: 3,
      timestamp: "2026-05-02T00:00:02.000Z",
      item: { type: "user_message", text: "second prompt" },
    },
    {
      seq: 4,
      timestamp: "2026-05-02T00:00:03.000Z",
      item: { type: "assistant_message", text: "second answer" },
    },
  ];
  const rootRequest = {
    type: "fetch_agent_timeline_request",
    requestId: "root",
    agentId: "agent-1",
    projection: "projected",
    direction: "after",
    cursor: { epoch: "epoch-1", seq: 0 },
    limit: 1,
  } as const;
  const childRequest = {
    type: "agent.provider_subagents.timeline.get.request",
    requestId: "child",
    parentAgentId: "agent-1",
    subagentId: "subagent-1",
    direction: "after",
    cursor: { epoch: "subagent-epoch-1", seq: 2 },
    limit: 0,
  } as const;

  test("a paused client receives a large timeline burst without reconnecting", async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const accepted = deferred<WebSocket>();
    const tcpAccepted = deferred<Socket>();
    wss.once("connection", accepted.resolve);
    http.once("connection", tcpAccepted.resolve);
    const receiver = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const physical = await accepted.promise;
    const tcp = await tcpAccepted.promise;
    await once(receiver, "open");
    const text = "history".repeat(1024 * 1024);
    const received: string[] = [];
    const firstStarted = deferred();
    const otherMessages: SessionOutboundMessage[] = [];
    let highWater = 0;
    const session = createSessionForWireCompatTest({
      rows: [
        {
          seq: 1,
          timestamp: "2026-05-02T00:00:00.000Z",
          item: { type: "assistant_message", text },
        },
      ],
      onMessageToSource: async (source, message) => {
        if (source !== physical) {
          otherMessages.push(message);
          return;
        }
        const sending = sendBoundedPhysicalFrameAndWait({
          socket: physical,
          frame: JSON.stringify({ type: "session", message }),
          signal: session.delivery.requestSignal,
          onHighWater: () => {
            highWater++;
            session.clearAgentTimelineSubscription(physical);
            physical.terminate();
          },
        });
        firstStarted.resolve();
        await sending;
      },
    });
    session.updateClientCapabilities({ [CLIENT_CAPS.projectedSubagentTimeline]: true }, physical);
    const envelopeSchema = z.object({
      message: z.discriminatedUnion("type", [
        FetchAgentTimelineResponseMessageSchema,
        ProviderSubagentTimelineResponseMessageSchema,
      ]),
    });
    receiver.on("message", (data) => {
      const { message: response } = envelopeSchema.parse(JSON.parse(data.toString()));
      const entries =
        response.type === "fetch_agent_timeline_response"
          ? response.payload.entries
          : response.payload.rows;
      // Upstream bounds every timeline item (a4f696620), so the multi-megabyte
      // assistant row arrives truncated to the item budget with a marker.
      expect(entries).toMatchObject([
        {
          item: {
            type: "assistant_message",
            text: expect.stringMatching(/^history.*…\[truncated [\d.]+ [KMG]B\]$/),
          },
        },
      ]);
      received.push(response.payload.requestId);
    });
    let pending: Promise<void>[] = [];
    try {
      receiver.pause();
      // Corking makes physical backpressure independent of OS receive-buffer sizes.
      tcp.cork();
      const requestIds = Array.from({ length: 12 }, (_, index) => `burst-${index}`);
      pending = requestIds.map((requestId, index) => {
        const request = index % 2 === 0 ? rootRequest : childRequest;
        return session.handleMessage(
          { ...request, requestId, direction: "tail", limit: 0 },
          physical,
        );
      });
      await firstStarted.promise;
      const otherSource = {};
      await session.handleMessage({ ...rootRequest, requestId: "other" }, otherSource);
      await session.handleMessage(
        { type: "session.events.set_subscription.request", requestId: "control", events: [] },
        otherSource,
      );
      expect(otherMessages.map((message) => message.type)).toEqual([
        "fetch_agent_timeline_response",
        "session.events.set_subscription.response",
      ]);
      expect(highWater).toBe(0);
      expect(physical.readyState).toBe(WebSocket.OPEN);
      expect(physical.bufferedAmount).toBeGreaterThan(0);
      expect(physical.bufferedAmount).toBeLessThan(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES);
      receiver.resume();
      tcp.uncork();
      await Promise.all(pending);
      await expect.poll(() => received, { timeout: 10_000 }).toEqual(requestIds);
      expect(highWater).toBe(0);
      expect(physical.readyState).toBe(WebSocket.OPEN);
    } finally {
      session.clearAgentTimelineSubscription(physical);
      receiver.terminate();
      physical.terminate();
      tcp.destroy();
      await Promise.all(pending);
      await session.cleanup();
      const wsClosed = deferred();
      wss.close(() => wsClosed.resolve());
      await wsClosed.promise;
      const httpClosed = deferred();
      http.close(() => httpClosed.resolve());
      await httpClosed.promise;
    }
  });

  test.each(["root", "child"] as const)(
    "drops queued pages when a source closes during a pending %s send",
    async (kind) => {
      const manager = new InMemoryAgentManager(rows);
      const rootReads = vi.spyOn(manager, "fetchTimeline");
      const childReads = vi.spyOn(manager, "fetchProviderSubagentTimeline");
      const source = {};
      const started = deferred();
      const send = deferred();
      const messages: SessionOutboundMessage[] = [];
      const session = createSessionForWireCompatTest({
        manager,
        onMessageToSource: (_source, message) => {
          messages.push(message);
          started.resolve();
          return send.promise;
        },
      });
      session.updateClientCapabilities({ [CLIENT_CAPS.projectedSubagentTimeline]: true }, source);
      const first = session.handleMessage(kind === "root" ? rootRequest : childRequest, source);
      await started.promise;
      const queuedRoot = session.handleMessage(
        { ...rootRequest, requestId: "queued-root" },
        source,
      );
      const queuedChild = session.handleMessage(
        { ...childRequest, requestId: "queued-child" },
        source,
      );
      session.clearAgentTimelineSubscription(source);
      send.resolve();
      await Promise.all([first, queuedRoot, queuedChild]);

      expect(rootReads).toHaveBeenCalledTimes(kind === "root" ? 1 : 0);
      expect(childReads).toHaveBeenCalledTimes(kind === "child" ? 1 : 0);
      expect(messages).toHaveLength(1);
      if (kind === "root") {
        expect(FetchAgentTimelineResponseMessageSchema.parse(messages[0]).payload).toMatchObject({
          entries: [{ item: { text: "first prompt" } }],
          endCursor: { epoch: "epoch-1", seq: 1 },
          error: null,
        });
      } else {
        expect(
          ProviderSubagentTimelineResponseMessageSchema.parse(messages[0]).payload,
        ).toMatchObject({
          rows: [{ item: { text: "second prompt" } }, { item: { text: "second answer" } }],
          endCursor: { epoch: "subagent-epoch-1", seq: 4 },
          error: null,
        });
      }
      await session.cleanup();
    },
  );

  test.each(["root", "child"] as const)(
    "does not produce or send a %s page after its source closes during loading",
    async (kind) => {
      const manager = new InMemoryAgentManager(rows);
      const rootReads = vi.spyOn(manager, "fetchTimeline");
      const childReads = vi.spyOn(manager, "fetchProviderSubagentTimeline");
      const loadStarted = deferred();
      const load = deferred();
      vi.spyOn(manager, "waitForAgentClose").mockImplementationOnce(() => {
        loadStarted.resolve();
        return load.promise;
      });
      const messages: SessionOutboundMessage[] = [];
      const session = createSessionForWireCompatTest({ manager, messages });
      const source = {};
      const first = session.handleMessage(kind === "root" ? rootRequest : childRequest, source);
      await loadStarted.promise;
      const queued = session.handleMessage({ ...rootRequest, requestId: "queued" }, source);
      session.clearAgentTimelineSubscription(source);
      load.resolve();
      await Promise.all([first, queued]);

      expect(rootReads).not.toHaveBeenCalled();
      expect(childReads).not.toHaveBeenCalled();
      expect(messages).toEqual([]);
      await session.cleanup();
    },
  );

  test("continues catch-up after a timeline error response drains", async () => {
    const manager = new InMemoryAgentManager(rows);
    vi.spyOn(manager, "fetchTimeline").mockImplementationOnce(() => {
      throw new Error("timeline page failed");
    });
    const started = deferred();
    const send = deferred();
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({
      manager,
      onMessageToSource: (_source, message) => {
        messages.push(message);
        if (
          message.type === "fetch_agent_timeline_response" &&
          message.payload.requestId === "failed"
        ) {
          started.resolve();
          return send.promise;
        }
      },
    });
    const source = {};
    const first = session.handleMessage({ ...rootRequest, requestId: "failed" }, source);
    await started.promise;
    const next = session.handleMessage({ ...rootRequest, requestId: "next" }, source);
    await session.handleMessage(
      { type: "session.events.set_subscription.request", requestId: "control", events: [] },
      source,
    );
    expect(messages.at(-1)).toMatchObject({
      type: "session.events.set_subscription.response",
      payload: { requestId: "control" },
    });
    send.resolve();
    await Promise.all([first, next]);
    expect(FetchAgentTimelineResponseMessageSchema.parse(messages[0]).payload).toMatchObject({
      requestId: "failed",
      entries: [],
      startCursor: null,
      endCursor: null,
      error: "timeline page failed",
    });
    expect(FetchAgentTimelineResponseMessageSchema.parse(messages[2]).payload).toMatchObject({
      requestId: "next",
      entries: [{ item: { text: "first prompt" } }],
      endCursor: { epoch: "epoch-1", seq: 1 },
      error: null,
    });
    await session.cleanup();
  });

  test("a rejected physical send does not strand the next timeline request", async () => {
    const manager = new InMemoryAgentManager(rows);
    const started = deferred();
    const send = deferred();
    const sendError = new Error("physical send failed");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({
      manager,
      onMessageToSource: (_source, message) => {
        messages.push(message);
        if (
          message.type === "fetch_agent_timeline_response" &&
          message.payload.requestId === "failed"
        ) {
          started.resolve();
          return send.promise;
        }
      },
    });
    const source = {};
    const first = session.handleMessage({ ...rootRequest, requestId: "failed" }, source);
    await started.promise;
    const next = session.handleMessage({ ...rootRequest, requestId: "next" }, source);
    send.reject(sendError);
    await Promise.all([first, next]);
    expect(FetchAgentTimelineResponseMessageSchema.parse(messages.at(-1)).payload).toMatchObject({
      requestId: "next",
      entries: [{ item: { text: "first prompt" } }],
      startCursor: { epoch: "epoch-1", seq: 1 },
      endCursor: { epoch: "epoch-1", seq: 1 },
      error: null,
    });
    await session.cleanup();
  });
});

describe("timeline RPC byte budgets", () => {
  const rows: AgentTimelineRow[] = Array.from({ length: 12 }, (_, index) => ({
    seq: index + 1,
    timestamp: "2026-05-02T00:00:00.000Z",
    item: {
      type: index % 2 === 0 ? "user_message" : "assistant_message",
      text: `${index}:` + "界".repeat(8 * 1024),
    },
  }));

  test.each([false, true])(
    "root backward pages preserve every row with wholeTurns=%s",
    async (wholeTurns) => {
      const messages: SessionOutboundMessage[] = [];
      const session = createSessionForWireCompatTest({ rows, messages });
      const collected: unknown[] = [];
      let cursor: { epoch: string; seq: number } | undefined;
      let pages = 0;
      try {
        for (;;) {
          await session.handleMessage({
            type: "fetch_agent_timeline_request",
            requestId: `backward-${pages}`,
            agentId: "agent-1",
            direction: cursor ? "before" : "tail",
            cursor,
            limit: 0,
            wholeTurns,
          });
          const page = FetchAgentTimelineResponseMessageSchema.parse(messages.at(-1)).payload;
          expect(page.error).toBeNull();
          expect(page.entries.length).toBeGreaterThan(0);
          expect(page.entries.length).toBeLessThanOrEqual(wholeTurns ? 2 : 3);
          expect(page.hasNewer).toBe(cursor !== undefined);
          if (wholeTurns) {
            expect(page.entries.map((entry) => entry.item.type)).toEqual([
              "user_message",
              "assistant_message",
            ]);
          }
          for (const entry of page.entries) {
            expect(entry.sourceSeqRanges).toEqual([
              { startSeq: entry.seqStart, endSeq: entry.seqEnd },
            ]);
          }
          collected.unshift(...page.entries.map((entry) => entry.item));
          expect(page.startCursor).not.toBeNull();
          if (cursor) expect(page.startCursor!.seq).toBeLessThan(cursor.seq);
          cursor = page.startCursor!;
          pages += 1;
          expect(pages).toBeLessThanOrEqual(rows.length);
          if (!page.hasOlder) break;
        }
        expect(pages).toBeGreaterThan(1);
        expect(collected).toEqual(rows.map((row) => row.item));
        expect(cursor?.seq).toBe(1);
      } finally {
        await session.cleanup();
      }
    },
  );

  test.each(["root", "child-default", "child-zero"] as const)(
    "%s forward catch-up remains byte-budgeted until every row is available",
    async (kind) => {
      const messages: SessionOutboundMessage[] = [];
      const session = createSessionForWireCompatTest({
        rows,
        messages,
        clientCapabilities: { [CLIENT_CAPS.projectedSubagentTimeline]: true },
      });
      const collected: unknown[] = [];
      let cursor = { epoch: kind === "root" ? "epoch-1" : "subagent-epoch-1", seq: 0 };
      let pages = 0;
      try {
        for (;;) {
          if (kind === "root") {
            await session.handleMessage({
              type: "fetch_agent_timeline_request",
              requestId: `forward-${pages}`,
              agentId: "agent-1",
              direction: "after",
              cursor,
              limit: 0,
              wholeTurns: true,
            });
          } else {
            await session.handleMessage({
              type: "agent.provider_subagents.timeline.get.request",
              requestId: `forward-${pages}`,
              parentAgentId: "agent-1",
              subagentId: "subagent-1",
              direction: "after",
              cursor,
              ...(kind === "child-zero" ? { limit: 0 } : {}),
            });
          }
          const response = messages.at(-1);
          const page =
            kind === "root"
              ? FetchAgentTimelineResponseMessageSchema.parse(response).payload
              : ProviderSubagentTimelineResponseMessageSchema.parse(response).payload;
          const entries = "entries" in page ? page.entries : page.rows;
          expect(page.error).toBeNull();
          expect(page.reset).toBe(false);
          expect(page.staleCursor).toBe(false);
          expect(page.gap).toBe(false);
          expect(entries.length).toBeGreaterThan(0);
          expect(entries.length).toBeLessThanOrEqual(3);
          expect(page.startCursor?.seq).toBe(cursor.seq + 1);
          expect(page.endCursor?.seq).toBe(cursor.seq + entries.length);
          collected.push(...entries.map((entry) => entry.item));
          expect(page.endCursor).not.toBeNull();
          cursor = page.endCursor!;
          pages += 1;
          expect(pages).toBeLessThanOrEqual(rows.length);
          if (!page.hasNewer) break;
        }
        expect(pages).toBeGreaterThan(1);
        expect(cursor.seq).toBe(rows.length);
        expect(collected).toEqual(rows.map((row) => row.item));
      } finally {
        await session.cleanup();
      }
    },
  );

  test("child tail and backward pages preserve all rows", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({
      rows,
      messages,
      clientCapabilities: { [CLIENT_CAPS.projectedSubagentTimeline]: true },
    });
    const collected: unknown[] = [];
    let cursor: { epoch: string; seq: number } | undefined;
    let pages = 0;
    try {
      for (;;) {
        await session.handleMessage({
          type: "agent.provider_subagents.timeline.get.request",
          requestId: `child-backward-${pages}`,
          parentAgentId: "agent-1",
          subagentId: "subagent-1",
          direction: cursor ? "before" : "tail",
          cursor,
          limit: 0,
        });
        const page = ProviderSubagentTimelineResponseMessageSchema.parse(messages.at(-1)).payload;
        expect(page.error).toBeNull();
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.rows.length).toBeLessThanOrEqual(3);
        collected.unshift(...page.rows.map((row) => row.item));
        expect(page.startCursor).not.toBeNull();
        if (cursor) expect(page.startCursor!.seq).toBeLessThan(cursor.seq);
        cursor = page.startCursor!;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(rows.length);
        if (!page.hasOlder) break;
      }
      expect(pages).toBeGreaterThan(1);
      expect(cursor?.seq).toBe(1);
      expect(collected).toEqual(rows.map((row) => row.item));
    } finally {
      await session.cleanup();
    }
  });

  test("a whole turn larger than the budget stays intact and older history remains reachable", async () => {
    const giantRows: AgentTimelineRow[] = rows.slice(0, 4).map((row, index) => ({
      seq: row.seq,
      timestamp: row.timestamp,
      item: {
        type: index % 2 === 0 ? "user_message" : "assistant_message",
        text: `${index}:` + "界".repeat(20 * 1024),
      },
    }));
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({ rows: giantRows, messages });
    try {
      await session.handleMessage({
        type: "fetch_agent_timeline_request",
        requestId: "giant-tail",
        agentId: "agent-1",
        direction: "tail",
        limit: 1,
        wholeTurns: true,
      });
      const tail = FetchAgentTimelineResponseMessageSchema.parse(messages.at(-1)).payload;
      expect(tail.error).toBeNull();
      expect(tail.entries.map((entry) => entry.item)).toEqual(
        giantRows.slice(2).map((row) => row.item),
      );
      expect(Buffer.byteLength(JSON.stringify(tail.entries), "utf8")).toBeGreaterThan(96 * 1024);
      expect(tail.startCursor?.seq).toBe(3);
      expect(tail.endCursor?.seq).toBe(4);
      expect(tail.hasOlder).toBe(true);
      await session.handleMessage({
        type: "fetch_agent_timeline_request",
        requestId: "giant-before",
        agentId: "agent-1",
        direction: "before",
        cursor: tail.startCursor!,
        limit: 1,
        wholeTurns: true,
      });
      const older = FetchAgentTimelineResponseMessageSchema.parse(messages.at(-1)).payload;
      expect(older.error).toBeNull();
      expect(older.entries.map((entry) => entry.item)).toEqual(
        giantRows.slice(0, 2).map((row) => row.item),
      );
      expect(older.startCursor?.seq).toBe(1);
      expect(older.endCursor?.seq).toBe(2);
      expect(older.hasOlder).toBe(false);
    } finally {
      await session.cleanup();
    }
  });
});

describe("wire compatibility", () => {
  test("sends project updates only to clients that declare support", async () => {
    const project = createPersistedProjectRecord({
      projectId: "project-1",
      rootPath: "/tmp/project",
      kind: "git",
      displayName: "project",
      customName: "Favorite project",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    const legacyMessages: SessionOutboundMessage[] = [];
    const capableMessages: SessionOutboundMessage[] = [];
    const legacy = createSessionForWireCompatTest({ messages: legacyMessages });
    const capable = createSessionForWireCompatTest({
      clientCapabilities: { [CLIENT_CAPS.projectUpdates]: true },
      messages: capableMessages,
    });

    await Promise.all([
      legacy.emitProjectUpdate({ kind: "upsert", project }),
      legacy.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
      capable.emitProjectUpdate({ kind: "upsert", project }),
      capable.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
    ]);

    expect(legacyMessages).toEqual([]);
    expect(capableMessages.map((message) => SessionOutboundMessageSchema.parse(message))).toEqual([
      {
        type: "project.update",
        payload: {
          generation: expect.any(String),
          seq: 1,
          kind: "upsert",
          project: {
            projectId: "project-1",
            projectDisplayName: "Favorite project",
            projectCustomName: "Favorite project",
            projectCustomIconRevision: null,
            projectIconRevision: "automatic:none:v1",
            projectRootPath: "/tmp/project",
            projectKind: "git",
          },
        },
      },
      {
        type: "project.update",
        payload: { kind: "remove", projectId: "project-1", generation: expect.any(String), seq: 2 },
      },
    ]);
  });

  test("publishes rapid project mutations in order before incremental reconciliation", async () => {
    const directorySync = new DirectorySyncService("generation");
    const initial = directorySync.synchronizeProjects([], {});
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForWireCompatTest({
      clientCapabilities: { [CLIENT_CAPS.projectUpdates]: true },
      directorySync,
      messages,
    });
    const project = createPersistedProjectRecord({
      projectId: "project-ordered",
      rootPath: "/tmp/project-ordered",
      kind: "git",
      displayName: "Ordered project",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    await Promise.all([
      session.emitProjectUpdate({ kind: "upsert", project }),
      session.emitProjectUpdate({ kind: "remove", projectId: project.projectId }),
    ]);

    expect(
      messages.flatMap((message) =>
        message.type === "project.update" ? [message.payload.kind] : [],
      ),
    ).toEqual(["upsert", "remove"]);
    expect(
      directorySync.synchronizeProjects([], {
        generation: initial.sync.generation,
        afterSeq: initial.sync.headSeq,
      }),
    ).toEqual({
      projects: [],
      sync: {
        generation: "generation",
        mode: "changes",
        headSeq: 2,
        removals: [{ id: "project-ordered", seq: 2 }],
      },
    });
  });

  test("downgrades reasoning_merge for clients that do not declare the capability", async () => {
    const response = await emitTimelineResponse();

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).not.toContain("reasoning_merge");

    const legacyParsed = LegacyFetchAgentTimelineResponseMessageSchema.parse(response);
    expect(legacyParsed.payload.entries[0]?.collapsed).toEqual([]);
  });

  test("preserves reasoning_merge for clients that declare the capability", async () => {
    const response = await emitTimelineResponse({
      clientCapabilities: { [CLIENT_CAPS.reasoningMergeEnum]: true },
    });

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).toContain("reasoning_merge");
  });

  test("carries canonical turn IDs to new clients while legacy schemas ignore them", async () => {
    const response = await emitTimelineResponse({
      rows: [
        {
          seq: 1,
          timestamp: "2026-05-02T00:00:00.000Z",
          turnId: "turn-1",
          item: { type: "user_message", text: "prompt", clientMessageId: "message-1" },
        },
        {
          seq: 2,
          timestamp: "2026-05-02T00:00:01.000Z",
          turnId: "turn-1",
          item: { type: "assistant_message", text: "done" },
        },
      ],
    });

    expect(FetchAgentTimelineResponseMessageSchema.parse(response).payload.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ turnId: "turn-1" })]),
    );
    expect(LegacyFetchAgentTimelineResponseMessageSchema.parse(response).payload.entries).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ turnId: expect.anything() })]),
    );
  });

  test("legacy worktree request shape normalizes to the same internal input as the new shape", async () => {
    const workflow = new InMemoryWorktreeWorkflow();

    const dependencies = {
      paseoHome: "/tmp/paseo-home",
      describeWorkspaceRecord: async () =>
        ({
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "repo",
          cwd: "/tmp/repo",
          status: "ready",
          activityAt: null,
          scripts: [],
        }) as never,
      emit() {},
      sessionLogger: pino({ level: "silent" }),
      createPaseoWorktreeWorkflow: workflow.create.bind(workflow),
    };

    const legacyRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-legacy",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      nameContext: "Investigate flaky test",
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 55,
          title: "Improve startup error details",
          url: "https://github.com/getpaseo/paseo/issues/55",
        },
      ],
    });

    const newRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-new",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
    });

    if (legacyRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected legacy worktree request");
    }
    if (newRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected new worktree request");
    }

    await handleCreatePaseoWorktreeRequest(dependencies, legacyRequest);
    await handleCreatePaseoWorktreeRequest(dependencies, newRequest);

    expect(workflow.capturedInputs).toHaveLength(2);
    expect(workflow.capturedInputs[0]).toEqual(workflow.capturedInputs[1]);
    expect(workflow.capturedInputs[0]).toEqual({
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
      refName: undefined,
      action: undefined,
      githubPrNumber: undefined,

      paseoHome: "/tmp/paseo-home",
    });
  });
});

test("setup progress is adapted per socket without changing the canonical snapshot", async () => {
  const legacy = {};
  const capable = {};
  const modern = {};
  const modernCapable = {};
  const delivered = new Map<object, SessionOutboundMessage[]>();
  const session = createSessionForWireCompatTest({
    onMessageToSource: (source, message) => {
      delivered.set(source, [...(delivered.get(source) ?? []), message]);
    },
  });
  for (const [source, blocked, owned] of [
    [legacy, false, false],
    [capable, true, false],
    [modern, false, true],
    [modernCapable, true, true],
  ] as const) {
    session.updateClientCapabilities(
      {
        explicit_event_subscriptions: true,
        owned_subscriptions: owned,
        workspace_setup_blocked: blocked,
      },
      source,
    );
    await session.handleMessage(
      {
        type: "session.events.set_subscription.request",
        requestId: "setup",
        events: ["workspace_setup_progress"],
      },
      source,
    );
    expect(delivered.get(source)).toContainEqual(
      expect.objectContaining({ type: "session.events.set_subscription.response" }),
    );
  }
  delivered.clear();
  const message = {
    type: "workspace_setup_progress" as const,
    payload: {
      workspaceId: "fork-workspace",
      status: "blocked" as const,
      error: null,
      detail: {
        type: "worktree_setup" as const,
        worktreePath: "/workspace",
        branchName: "fork",
        log: "",
        commands: [],
      },
      blockedSource: {
        kind: "change_request" as const,
        forge: "github",
        number: 42,
        headRepository: "contributor/project",
      },
    },
  };
  session.publish(message);
  expect(delivered.get(capable)).toEqual([message]);
  expect(delivered.get(legacy)).toEqual([
    {
      ...message,
      payload: {
        ...message.payload,
        status: "failed",
        error:
          "Workspace setup is blocked pending approval of code from a fork pull request. Update Paseo to review and run setup.",
      },
    },
  ]);
  expect(delivered.get(modernCapable)).toEqual([
    { ...message, payload: { ...message.payload, subscriptionId: expect.any(String) } },
  ]);
  expect(delivered.get(modern)).toEqual([
    {
      ...message,
      payload: {
        ...message.payload,
        status: "failed",
        error: expect.stringContaining("Update Paseo"),
        subscriptionId: expect.any(String),
      },
    },
  ]);
  expect(message.payload.status).toBe("blocked");
  await session.cleanup();
});

test("scoped setup clients never receive session-wide setup output", async () => {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({
    messages,
    clientCapabilities: { owned_subscriptions: true, workspace_setup_observation: true },
  });
  const source = {};
  session.updateClientCapabilities(
    { owned_subscriptions: true, workspace_setup_observation: true },
    source,
  );
  await session.handleMessage(
    {
      type: "session.events.set_subscription.request",
      requestId: "events",
      events: ["workspace_setup_progress"],
    },
    source,
  );
  messages.length = 0;
  for (const workspaceId of ["setup-a", "setup-b", "setup-c"]) {
    for (let chunk = 0; chunk < 10; chunk++) {
      session.publish({
        type: "workspace_setup_progress",
        payload: {
          workspaceId,
          status: "running",
          error: null,
          detail: {
            type: "worktree_setup",
            worktreePath: "/workspace",
            branchName: "setup",
            log: "output".repeat(chunk * 1000),
            commands: [],
          },
        },
      });
    }
  }
  expect(messages).toEqual([]);
  await session.cleanup();
});

test("setup output invalidates directory metadata only when visible setup status changes", () => {
  const setup = new WorkspaceSetupObservation();
  const earlier = {
    status: "failed" as const,
    error: "failed before any connection",
    detail: {
      type: "worktree_setup" as const,
      worktreePath: "/workspace",
      branchName: "test",
      log: "earlier output",
      commands: [],
    },
  };
  setup.publish("earlier", earlier);
  expect(setup.get("earlier")).toEqual(earlier);
  expect(setup.status({ workspaceId: "earlier", untrustedSource: null })).toBe("failed");
  const changes: boolean[] = [];
  setup.subscribe((_workspaceId, _snapshot, changed) => changes.push(changed));
  const detail = {
    type: "worktree_setup" as const,
    worktreePath: "/workspace",
    branchName: "test",
    log: "",
    commands: [
      {
        index: 0,
        command: "setup",
        cwd: "/workspace",
        log: "",
        status: "running" as const,
        exitCode: null,
      },
    ],
  };
  for (const log of ["", "one", "one two", "one two three"])
    setup.publish("workspace", { status: "running", error: null, detail: { ...detail, log } });
  setup.publish("workspace", { status: "failed", error: "failed", detail });
  expect(changes).toEqual([true, false, false, false, true]);
  expect(setup.status({ workspaceId: "workspace", untrustedSource: null })).toBe("failed");
  expect(setup.status({ workspaceId: "empty", untrustedSource: null })).toBeNull();
  setup.publish("empty", { status: "completed", error: null, detail: { ...detail, commands: [] } });
  expect(setup.status({ workspaceId: "empty", untrustedSource: null })).toBeNull();
});

test("setup observation includes a transition that happens during its initial registry read", async () => {
  let completeRead!: (value: null) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const pendingRead = new Promise<null>((resolve) => {
    completeRead = resolve;
  });
  const messages: SessionOutboundMessage[] = [];
  const source = {};
  const session = createSessionForWireCompatTest({
    messages,
    clientCapabilities: { owned_subscriptions: true, workspace_setup_observation: true },
    workspaceRegistry: {
      get: () => {
        readStarted();
        return pendingRead;
      },
      list: () => [],
    } as unknown as SessionOptions["workspaceRegistry"],
  });
  session.updateClientCapabilities(
    { owned_subscriptions: true, workspace_setup_observation: true },
    source,
  );
  try {
    const request = session.handleMessage(
      { type: "workspace.setup.subscribe.request", workspaceId: "setup", requestId: "observe" },
      source,
    );
    await started;
    session.publish({
      type: "workspace_setup_progress",
      payload: {
        workspaceId: "setup",
        status: "failed",
        error: "bootstrap failure",
        detail: {
          type: "worktree_setup",
          worktreePath: "/workspace",
          branchName: "test",
          log: "failure output",
          commands: [],
        },
      },
    });
    completeRead(null);
    await request;
    expect(messages).toEqual([
      {
        type: "workspace.setup.subscribe.response",
        payload: {
          requestId: "observe",
          workspaceId: "setup",
          subscriptionId: expect.any(String),
          snapshot: {
            status: "failed",
            error: "bootstrap failure",
            detail: {
              type: "worktree_setup",
              worktreePath: "/workspace",
              branchName: "test",
              log: "failure output",
              commands: [],
            },
          },
        },
      },
    ]);
  } finally {
    await session.cleanup();
  }
});
