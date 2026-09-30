import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { mapOmpIrcMessageToToolCall } from "./irc-message.js";
import { streamOmpCoreHistory, type OmpCapturedUserMessageEntry } from "./message-history.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { readOmpHistoryTodoState, streamOmpHistory } from "./history.js";

async function collectHistory(
  messages: OmpAgentMessage[],
  userEntries: OmpCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamOmpCoreHistory(
    "omp",
    messages,
    userEntries,
    OMP_HISTORY_MAPPER_HOOKS,
  )) {
    events.push(event);
  }
  return events;
}

describe("OMP history mapper", () => {
  test("renders visible custom messages as completed tools with their type and content", async () => {
    const events = await collectHistory([
      {
        role: "custom",
        customType: "project-context",
        content: "Project instructions",
        display: true,
      },
      {
        role: "custom",
        customType: "private-context",
        content: "Hidden instructions",
        display: false,
      },
      {
        role: "custom",
        customType: "project-context",
        content: "Project instructions",
        display: true,
      },
    ]);
    expect(events.map((event) => event.item)).toEqual(
      [1, 2].map((index) => ({
        type: "tool_call",
        callId: `omp-custom-${index}`,
        name: "project-context",
        status: "completed",
        detail: { type: "plain_text", text: "Project instructions" },
        metadata: { synthetic: true, customType: "project-context" },
        error: null,
      })),
    );
  });

  test("replays a web search details error as failed when OMP sets isError false", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "web-1", name: "web_search", arguments: { query: "Paseo" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "web-1",
        toolName: "web_search",
        content: [{ type: "text", text: "Error: All web search providers failed" }],
        details: {
          error: "All web search providers failed",
          response: { provider: "none", sources: [] },
        },
        isError: false,
      },
    ]);
    expect(events.at(-1)?.item).toMatchObject({
      type: "tool_call",
      status: "failed",
      error: "All web search providers failed",
    });
  });

  test("replays a Paseo browser tool result whose details error is an object", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "shot-1", name: "browser_screenshot", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "shot-1",
        toolName: "browser_screenshot",
        content: [{ type: "text", text: "The tab has not painted yet. Retry the screenshot." }],
        details: {
          ok: false,
          error: {
            code: "screenshot_no_frame",
            message: "The tab has not painted yet. Retry the screenshot.",
            retryable: true,
          },
        },
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "Retrying later." }] },
    ]);

    expect(events.map((event) => event.item)).toEqual([
      expect.objectContaining({ type: "tool_call", callId: "shot-1", status: "running" }),
      expect.objectContaining({
        type: "tool_call",
        callId: "shot-1",
        name: "browser_screenshot",
        detail: expect.objectContaining({
          type: "unknown",
          output: expect.objectContaining({
            details: expect.objectContaining({
              error: expect.objectContaining({ code: "screenshot_no_frame", retryable: true }),
            }),
          }),
        }),
      }),
      expect.objectContaining({ type: "assistant_message", text: "Retrying later." }),
    ]);
  });

  test("reports a failed tool's structured details error by its message", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tabs-1", name: "browser_list_tabs", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "tabs-1",
        toolName: "browser_list_tabs",
        content: [],
        details: {
          ok: false,
          error: {
            code: "browser_no_host",
            message: "No browser automation host is connected.",
            retryable: true,
          },
        },
        isError: true,
      },
    ]);

    expect(events.at(-1)?.item).toMatchObject({
      type: "tool_call",
      status: "failed",
      error: "No browser automation host is connected.",
    });
  });

  test("restores blocked and abandoned todo state from a session file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-todo-state-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root" },
        {
          type: "message",
          id: "todos",
          parentId: "root",
          message: {
            role: "toolResult",
            toolName: "todo",
            details: {
              phases: [
                {
                  name: "Tasks",
                  tasks: [
                    { content: "Wait for approval", status: "blocked", blocker: "review" },
                    { content: "Old route", status: "abandoned" },
                  ],
                },
              ],
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect(await readOmpHistoryTodoState(sessionFile)).toEqual({
      type: "todo",
      items: [{ text: "Wait for approval (blocked: review)", status: "pending", completed: false }],
    });
  });

  test("hides persisted developer reminders and shows other developer messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-developer-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root" },
        {
          type: "message",
          id: "reminder",
          parentId: "root",
          message: {
            role: "developer",
            attribution: "agent",
            content: [
              {
                type: "text",
                text: "<system-reminder>\nContinue unfinished tasks\n</system-reminder>",
              },
            ],
          },
        },
        {
          type: "message",
          id: "other",
          parentId: "reminder",
          message: {
            role: "developer",
            content: [{ type: "text", text: "External instruction" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" }))
      events.push(event);
    expect(events.map((event) => event.item)).toEqual([
      {
        type: "tool_call",
        callId: "omp-custom-1",
        name: "custom-message",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "[developer] External instruction",
        },
        metadata: { synthetic: true, customType: "custom-message" },
        error: null,
      },
    ]);
  });

  test("replays a rule-violation run with the same rows the live timeline showed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-rule-reminder-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root" },
        {
          type: "message",
          id: "prompt",
          parentId: "root",
          message: {
            role: "user",
            content: "Read @notes.md, then write tiny.ts",
          },
        },
        {
          type: "message",
          id: "mention",
          parentId: "prompt",
          message: {
            role: "fileMention",
            files: [
              {
                path: "notes.md",
                content: "[notes.md#468D]\n1:# notes",
                lineCount: 1,
              },
            ],
          },
        },
        {
          type: "ttsr_injection",
          id: "injection",
          parentId: "mention",
          injectedRules: ["ts-no-tiny-functions"],
        },
        {
          type: "message",
          id: "rule-reminder",
          parentId: "injection",
          message: {
            role: "developer",
            content: [
              {
                type: "text",
                text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions">\nAvoid tiny functions.\n</system-reminder>',
              },
            ],
          },
        },
        {
          type: "message",
          id: "answer",
          parentId: "rule-reminder",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "FINAL_ANSWER" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      provider: "omp",
    }))
      events.push(event);
    expect(events.map((event) => event.item)).toEqual([
      {
        type: "user_message",
        text: "Read @notes.md, then write tiny.ts",
        messageId: "prompt",
      },
      {
        type: "assistant_message",
        text: "FINAL_ANSWER",
        messageId: "omp-history-assistant-1",
      },
    ]);
  });

  test("coalesces replayed subagent poll calls by target set", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "poll-1", name: "subagent", arguments: { poll: ["job-a"] } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-1",
        toolName: "subagent",
        content: [{ type: "text", text: "first poll" }],
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "poll-2", name: "subagent", arguments: { poll: ["job-a"] } },
          { type: "toolCall", id: "poll-3", name: "subagent", arguments: { poll: ["job-b"] } },
          {
            type: "toolCall",
            id: "spawn-1",
            name: "subagent",
            arguments: { spawn: [{ task: "go" }] },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-2",
        toolName: "subagent",
        content: [{ type: "text", text: "second poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "poll-3",
        toolName: "subagent",
        content: [{ type: "text", text: "other poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "spawn-1",
        toolName: "subagent",
        content: [{ type: "text", text: "spawned" }],
      },
    ]);

    expect(
      events.map((event) => (event.item.type === "tool_call" ? event.item.callId : null)),
    ).toEqual([
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
    ]);
  });

  test("maps replayed OMP system-notice custom messages to tool-call rows", async () => {
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
      '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
      "<output>done</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "custom", content: notice, id: "notice-entry-1" },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-notice:notice-entry-1",
          name: "system_notice",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Background job DocsSmokeTwo completed",
            text: [
              "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
              '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
              "<output>done</output>",
              "</task-result>",
            ].join("\n"),
            icon: "bot",
          },
          metadata: { synthetic: true, source: "omp_system_notice" },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });

  test("replays every job in a parallel notice payload as its own row", async () => {
    const notice = [
      "<system-notice>",
      "2 background jobs have completed. Resume your work using the results below.",
      "",
      "── Job FixBuild (FixBuild) ──",
      '<task-result id="FixBuild" status="completed">',
      "<output>build ok</output>",
      "</task-result>",
      "── Job Sweep2161 (Sweep2161) ──",
      '<task-result id="Sweep2161" status="failed">',
      "<output>sweep blew up</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    const events = await collectHistory([
      { role: "custom", content: notice, id: "notice-parallel-1" },
    ]);

    expect(events.map((event) => event.item)).toMatchObject([
      {
        type: "tool_call",
        callId: "omp-notice:notice-parallel-1#0",
        status: "completed",
        detail: { type: "plain_text", label: "Background job FixBuild completed" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "omp-notice:notice-parallel-1#1",
        status: "failed",
        detail: { type: "plain_text", label: "Background job Sweep2161 failed" },
        error: "sweep blew up",
      },
    ]);
  });

  test("renders replayed OMP advisor messages as synthetic tool-call blocks", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: [
            {
              type: "text",
              text: '<advisory severity="blocker">Add an authorization check.</advisory>',
            },
          ],
          customType: "advisor",
          id: "advisor-message-1",
          display: true,
          details: {
            notes: [
              {
                note: "Add an authorization check.",
                severity: "blocker",
                advisor: "security",
              },
              { note: "Exercise the failure path.", severity: "concern" },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-advisor:advisor-message-1",
          name: "advisor",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Advisor · 2 notes · 1 blocker",
            text: "[blocker] [security] Add an authorization check.\n\n[concern] Exercise the failure path.",
            icon: "brain",
          },
          metadata: {
            synthetic: true,
            source: "omp_advisor",
            noteCount: 2,
            blockerCount: 1,
          },
          error: null,
        },
      },
    ]);
  });

  test("renders replayed OMP IRC messages as synthetic tool-call blocks", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: [
            "<irc>",
            "Incoming IRC message from agent `FortunaModeMigration`:",
            "",
            "Buy-prefix economics land in game 2218.",
            "",
            "If response expected, reply via `hub`.",
            "</irc>",
          ].join("\n"),
          customType: "irc:incoming",
          id: "irc-message-1",
          display: true,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-irc:irc-message-1",
          name: "irc",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "From `FortunaModeMigration`",
            text: "Buy-prefix economics land in game 2218.\n\nIf response expected, reply via `hub`.",
            icon: "bot",
          },
          metadata: { synthetic: true, source: "omp_irc", messageCount: 1 },
          error: null,
        },
      },
    ]);
  });

  test("keeps unclosed IRC payloads in one block and hashes the missing entry id", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: "<irc>\nIncoming IRC message from agent `IrisModeMigration`:\n\nhook exists.",
          customType: "irc:incoming",
          display: true,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-irc:7ffbe94da149",
          name: "irc",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "From `IrisModeMigration`",
            text: "hook exists.",
            icon: "bot",
          },
          metadata: { synthetic: true, source: "omp_irc", messageCount: 1 },
          error: null,
        },
      },
    ]);
  });

  test("keeps IRC content that follows a complete block", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: [
            "<irc>",
            "Incoming IRC message from agent `FortunaModeMigration`:",
            "",
            "First message.",
            "</irc>",
            "<irc>",
            "Incoming IRC message from agent `IrisModeMigration`:",
            "",
            "Second message, cut off mid-block",
          ].join("\n"),
          customType: "irc:incoming",
          id: "irc-truncated-1",
          display: true,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-irc:irc-truncated-1",
          name: "irc",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "2 messages",
            text: [
              "From `FortunaModeMigration`",
              "",
              "First message.",
              "",
              "From `IrisModeMigration`",
              "",
              "Second message, cut off mid-block",
            ].join("\n"),
            icon: "bot",
          },
          metadata: { synthetic: true, source: "omp_irc", messageCount: 2 },
          error: null,
        },
      },
    ]);
  });

  test("derives the same IRC callId from a live entryId and a replayed entry id", () => {
    const content = "<irc>\nIncoming IRC message from agent `IrisModeMigration`:\n\nhook exists.";

    expect(
      mapOmpIrcMessageToToolCall(
        {
          role: "custom",
          content,
          customType: "irc:incoming",
          entryId: "entry-1",
        } as OmpAgentMessage,
        content,
      )?.callId,
    ).toBe("omp-irc:entry-1");
    expect(
      mapOmpIrcMessageToToolCall(
        { role: "custom", content, customType: "irc:incoming", id: "entry-1" } as OmpAgentMessage,
        content,
      )?.callId,
    ).toBe("omp-irc:entry-1");
  });

  test("maps an empty IRC payload to a labeled row instead of assistant text", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: "<irc></irc>",
          customType: "irc:incoming",
          id: "irc-empty-1",
          display: true,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-irc:irc-empty-1",
          name: "irc",
          status: "completed",
          detail: { type: "plain_text", label: "Incoming message", icon: "bot" },
          metadata: { synthetic: true, source: "omp_irc", messageCount: 0 },
          error: null,
        },
      },
    ]);
  });

  test("omits replayed custom messages only when display is false", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "custom", content: "hidden reminder", display: false },
          { role: "custom", content: "visible explicit custom", display: true },
          { role: "custom", content: "visible legacy custom" },
          {
            role: "assistant",
            content: [{ type: "text", text: "assistant reply" }],
            responseId: "assistant-history",
          },
        ],
        [{ id: "entry-user-1", text: "first prompt" }],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-custom-1",
          name: "custom-message",
          status: "completed",
          detail: { type: "plain_text", text: "visible explicit custom" },
          metadata: { synthetic: true, customType: "custom-message" },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-custom-2",
          name: "custom-message",
          status: "completed",
          detail: { type: "plain_text", text: "visible legacy custom" },
          metadata: { synthetic: true, customType: "custom-message" },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "assistant_message",
          text: "assistant reply",
          messageId: "assistant-history",
        },
      },
    ]);
  });

  test("suppresses replayed raw todo tool calls through the OMP detail hook", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } }],
        },
        {
          role: "toolResult",
          toolCallId: "todo-1",
          toolName: "todo",
          content: [{ type: "text", text: "todos" }],
        },
      ]),
    ).resolves.toEqual([]);
  });

  test("replays task tool results as static sub-agent details", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "task-1",
              name: "task",
              arguments: { agent: "explore", description: "Inspect files" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "task-1",
          toolName: "task",
          content: [{ type: "text", text: "done\ntranscript: /tmp/omp-task/Explore.jsonl" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "running",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            log: "",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "completed",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            childSessionId: "/tmp/omp-task/Explore.jsonl",
            log: "done\ntranscript: /tmp/omp-task/Explore.jsonl",
          },
          error: null,
        },
      },
    ]);
  });
  test("replays OMP 17 xd writes as the executed inner tool", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "xd-write-call",
            name: "write",
            arguments: {
              path: "xd://browser",
              content: '{"action":"open","name":"docs","url":"https://example.com"}',
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "xd-write-call",
        toolName: "write",
        content: [{ type: "text", text: "Opened Example Domain" }],
        details: {
          xdev: {
            tool: "browser",
            mode: "execute",
            args: { action: "open", name: "docs", url: "https://example.com" },
            inner: { action: "open", name: "docs", url: "https://example.com" },
          },
        },
      } as OmpAgentMessage,
    ]);

    expect(events.at(-1)).toMatchObject({
      item: {
        type: "tool_call",
        callId: "xd-write-call",
        name: "browser",
        status: "completed",
        detail: {
          type: "unknown",
          input: { action: "open", name: "docs", url: "https://example.com" },
          output: {
            content: [{ type: "text", text: "Opened Example Domain" }],
            details: { action: "open", name: "docs", url: "https://example.com" },
          },
        },
      },
    });
    // The running row must share the completed row's detail type, or the timeline merge keeps
    // the running detail and drops the result.
    expect(
      events.flatMap((event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.callId === "xd-write-call"
          ? [event.item.detail.type]
          : [],
      ),
    ).toEqual(["plain_text", "unknown"]);
  });

  test("replays custom_message entries through the live custom-message path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-history-"));
    const sessionFile = join(dir, "session.jsonl");
    const notice = [
      "<system-notice>",
      "Background job bg_6 has completed. Resume your work using the result below.",
      '<task-result id="bg_6" status="completed">',
      "<output>58 passed</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "user-1",
          parentId: "root",
          message: { role: "user", content: "run the tests" },
        },
        {
          type: "custom_message",
          customType: "async-result",
          content: notice,
          display: true,
          id: "notice-1",
          parentId: "user-1",
        },
        {
          type: "custom_message",
          customType: "mid-run-todo-nudge",
          content: "<system-reminder>7 todo items still open.</system-reminder>",
          display: false,
          id: "nudge-1",
          parentId: "notice-1",
        },
        {
          type: "custom_message",
          customType: "launch-completion",
          content: "Supervised process dev-daemon exited with code 0.",
          display: true,
          id: "launch-1",
          parentId: "nudge-1",
        },
        {
          type: "custom_message",
          customType: "irc:incoming",
          content: [
            "<irc>",
            "Incoming IRC message from agent `FortunaModeMigration`:",
            "",
            "Buy-prefix economics land in game 2218.",
            "</irc>",
            "<irc>",
            "Incoming IRC message from agent `IrisModeMigration`:",
            "",
            "refineResolvedSpinMode hook exists.",
            "</irc>",
          ].join("\n"),
          display: true,
          id: "irc-1",
          parentId: "launch-1",
        },
        {
          type: "ttsr_injection",
          injectedRules: ["ts-no-tiny-functions"],
          id: "rules-1",
          parentId: "irc-1",
        },
        {
          type: "branch_summary",
          fromId: "rules-1",
          summary: "abandoned branch context",
          id: "branch-1",
          parentId: "rules-1",
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "branch-1",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "run the tests", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-notice:notice-1",
        name: "system_notice",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Background job bg_6 completed",
          text: [
            "Background job bg_6 has completed. Resume your work using the result below.",
            '<task-result id="bg_6" status="completed">',
            "<output>58 passed</output>",
            "</task-result>",
          ].join("\n"),
          icon: "bot",
        },
        metadata: { synthetic: true, source: "omp_system_notice" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "omp-custom-launch-1",
        name: "launch-completion",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "Supervised process dev-daemon exited with code 0.",
        },
        metadata: { synthetic: true, customType: "launch-completion" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "omp-irc:irc-1",
        name: "irc",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "2 messages",
          text: [
            "From `FortunaModeMigration`",
            "",
            "Buy-prefix economics land in game 2218.",
            "",
            "From `IrisModeMigration`",
            "",
            "refineResolvedSpinMode hook exists.",
          ].join("\n"),
          icon: "bot",
        },
        metadata: { synthetic: true, source: "omp_irc", messageCount: 2 },
        error: null,
      },
      { type: "assistant_message", text: "done", messageId: "omp-history-assistant-1" },
    ]);
  });

  test("maps only the active JSONL chain with native user ids and visible unknown roles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "user-old",
          parentId: "root",
          message: { role: "user", content: "old branch" },
        },
        {
          type: "message",
          id: "assistant-old",
          parentId: "user-old",
          message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        },
        {
          type: "session_init",
          id: "init-active",
          parentId: "root",
          systemPrompt: "must stay hidden",
        },
        {
          type: "message",
          id: "system-active",
          parentId: "init-active",
          message: { role: "system", content: "secret system prompt" },
        },
        {
          type: "message",
          id: "user-active",
          parentId: "system-active",
          message: { role: "user", content: "active branch" },
        },
        {
          type: "title",
          id: "title-control",
          parentId: "user-active",
          title: "Updated title",
        },
        {
          type: "custom",
          customType: "tool_execution_start",
          id: "custom-control",
          parentId: "title-control",
          data: { toolName: "task" },
        },
        {
          type: "tool_execution_start",
          id: "tool-control",
          parentId: "custom-control",
          command: "secret internal command",
        },
        {
          type: "future_control",
          id: "unknown-active",
          parentId: "tool-control",
          secret: "must not stringify",
        },
        {
          type: "message",
          id: "developer-active",
          parentId: "unknown-active",
          message: { role: "developer", content: "developer note" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "active branch", messageId: "user-active" },
      {
        type: "tool_call",
        callId: "omp-custom-1",
        name: "custom-message",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "[future_control] Unsupported history record",
        },
        metadata: { synthetic: true, customType: "custom-message" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "omp-custom-2",
        name: "custom-message",
        status: "completed",
        detail: { type: "plain_text", text: "[developer] developer note" },
        metadata: { synthetic: true, customType: "custom-message" },
        error: null,
      },
    ]);

    const omp = new FakeOmp();
    const runtimeSession = await omp.startSession({ cwd: dir });
    runtimeSession.activeBranchEntryId = "assistant-old";
    const selectedEvents: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      runtimeSession,
      provider: "omp",
    })) {
      selectedEvents.push(event);
    }
    expect(
      selectedEvents.flatMap((event) => (event.type === "timeline" ? [event.item] : [])),
    ).toEqual([
      { type: "user_message", text: "old branch", messageId: "user-old" },
      {
        type: "assistant_message",
        text: "old answer",
        messageId: "omp-history-assistant-1",
      },
    ]);
  });

  test("replays a compaction entry as a completed compaction row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-compaction-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "answer-1",
          parentId: "root",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Before." }],
            responseId: "resp-1",
          },
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "answer-1",
          timestamp: "2026-10-05T04:31:19.537Z",
          summary: "## Goal\nSummary",
          shortSummary: "Summary",
          firstKeptEntryId: "answer-1",
          tokensBefore: 77611,
          tokensAfter: 37526,
          method: "snapcompact",
          details: { readFiles: [], modifiedFiles: [] },
          fromExtension: false,
        },
        {
          type: "message",
          id: "answer-2",
          parentId: "compaction-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "After." }],
            responseId: "resp-2",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "assistant_message", text: "Before.", messageId: "resp-1" },
      { type: "compaction", status: "completed", preTokens: 77611 },
      { type: "assistant_message", text: "After.", messageId: "resp-2" },
    ]);
    expect(events[1]).toMatchObject({ type: "timeline", timestamp: "2026-10-05T04:31:19.537Z" });
  });

  test("skips model_usage accounting rows and marks compaction rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-model-usage-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "user-1",
          parentId: "root",
          timestamp: "2026-09-29T21:40:00.000Z",
          message: { role: "user", content: "keep going" },
        },
        {
          // omp persists auxiliary-call token/cost accounting as top-level
          // model_usage rows linked into the chain; they are not conversation.
          type: "model_usage",
          id: "usage-1",
          parentId: "user-1",
          timestamp: "2026-09-29T21:45:27.467Z",
          purpose: "unexpected-stop",
          role: "judge",
          api: "openai-responses",
          provider: "newapi",
          model: "glm-5.3",
          usage: { input: 808, output: 3, totalTokens: 811, cost: { total: 0.0011444 } },
          stopReason: "stop",
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "usage-1",
          timestamp: "2026-09-29T21:46:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "assistant-1",
          timestamp: "2026-09-29T21:47:00.000Z",
          summary: "Resume prior conversation. Earlier turns archived under HISTORY below.",
        },
        {
          type: "message",
          id: "user-2",
          parentId: "compaction-1",
          timestamp: "2026-09-29T21:48:00.000Z",
          message: { role: "user", content: "after compaction" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "keep going", messageId: "user-1" },
      { type: "assistant_message", text: "answer", messageId: "omp-history-assistant-1" },
      { type: "compaction", status: "completed" },
      { type: "user_message", text: "after compaction", messageId: "user-2" },
    ]);
    const compactionEvent = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline" && event.item.type === "compaction",
    );
    expect(compactionEvent).toMatchObject({
      type: "timeline",
      provider: "omp",
      item: { type: "compaction", status: "completed" },
      timestamp: "2026-09-29T21:47:00.000Z",
    });
  });

  test("maps omp 18.1 custom_message entries like live custom messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-custom-message-history-"));
    const sessionFile = join(dir, "session.jsonl");
    const skillPrompt =
      '[IMPORTANT: User invoked the "commit" skill; follow its instructions. Full skill below.]\n\n# Commit';
    const ircMessage = "<irc>\n<from>worker-1</from>\n<message>ready for review</message>\n</irc>";
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "answer-1",
          parentId: "root",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            responseId: "resp-1",
          },
        },
        {
          type: "custom_message",
          customType: "skill-prompt",
          content: skillPrompt,
          display: true,
          details: {
            name: "commit",
            path: "/home/me/.agents/skills/commit/SKILL.md",
            lineCount: 12,
          },
          attribution: "user",
          id: "skill-1",
          parentId: "answer-1",
          timestamp: "2026-09-13T13:11:35.811Z",
        },
        {
          type: "custom_message",
          customType: "irc:incoming",
          content: ircMessage,
          display: true,
          details: { from: "worker-1", message: "ready for review" },
          attribution: "user",
          id: "irc-1",
          parentId: "skill-1",
          timestamp: "2026-09-13T13:11:36.811Z",
        },
        {
          type: "custom_message",
          customType: "hidden-reminder",
          content: "must stay hidden",
          display: false,
          attribution: "user",
          id: "hidden-1",
          parentId: "irc-1",
          timestamp: "2026-09-13T13:11:37.811Z",
        },
        {
          type: "custom_message",
          customType: "legacy-no-display",
          content: "visible without display flag",
          attribution: "user",
          id: "legacy-1",
          parentId: "hidden-1",
          timestamp: "2026-09-13T13:11:38.811Z",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp" })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "assistant_message", text: "Done.", messageId: "resp-1" },
      { type: "user_message", text: "/skill:commit", messageId: "omp-custom-skill-1-user" },
      {
        type: "tool_call",
        callId: "omp-irc:irc-1",
        name: "irc",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Incoming message",
          text: "<from>worker-1</from>\n<message>ready for review</message>",
          icon: "bot",
        },
        metadata: { synthetic: true, source: "omp_irc", messageCount: 1 },
        error: null,
      },
      {
        type: "tool_call",
        callId: "omp-custom-legacy-1",
        name: "legacy-no-display",
        status: "completed",
        detail: {
          type: "plain_text",
          text: "visible without display flag",
        },
        metadata: { synthetic: true, customType: "legacy-no-display" },
        error: null,
      },
    ]);
  });

  test("synthesises the typed /skill bubble only for user-attributed skill prompts", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: '[IMPORTANT: User invoked the "improve" skill; follow its instructions.]',
          customType: "skill-prompt",
          display: true,
          details: {
            name: "improve",
            path: "/home/me/.agents/skills/improve/SKILL.md",
            lineCount: 9,
            args: "tests",
          },
          attribution: "user",
          id: "skill-args",
        },
        {
          role: "custom",
          content: '[IMPORTANT: Agent invoked the "improve" skill.]',
          customType: "skill-prompt",
          display: true,
          details: {
            name: "improve",
            path: "/home/me/.agents/skills/improve/SKILL.md",
            lineCount: 9,
          },
          attribution: "agent",
          id: "skill-agent",
        },
        {
          role: "custom",
          content: "<irc>\n<from>worker-1</from>\n<message>hi</message>\n</irc>",
          customType: "irc:incoming",
          display: true,
          details: { from: "worker-1", message: "hi" },
          attribution: "user",
          id: "irc-user",
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "/skill:improve tests",
          messageId: "omp-custom-skill-args-user",
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-custom-skill-agent",
          name: "skill-prompt",
          status: "completed",
          detail: {
            type: "plain_text",
            text: '[IMPORTANT: Agent invoked the "improve" skill.]',
          },
          metadata: {
            synthetic: true,
            customType: "skill-prompt",
            details: {
              name: "improve",
              path: "/home/me/.agents/skills/improve/SKILL.md",
              lineCount: 9,
            },
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-irc:irc-user",
          name: "irc",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Incoming message",
            text: "<from>worker-1</from>\n<message>hi</message>",
            icon: "bot",
          },
          metadata: { synthetic: true, source: "omp_irc", messageCount: 1 },
          error: null,
        },
      },
    ]);
  });

  test("rehydrates structured batch and nested task transcripts with stable status and time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-subagent-history-"));
    const parentFile = join(dir, "parent.jsonl");
    const parentStem = parentFile.slice(0, -".jsonl".length);
    const echoId = "EchoChild";
    const echoFile = join(parentStem, `${echoId}.jsonl`);
    const failedFile = join(parentStem, "FailedChild.jsonl");
    const abortedFile = join(parentStem, "AbortedChild.jsonl");
    const nestedFile = join(parentStem, echoId, "NestedChild.jsonl");
    mkdirSync(join(parentStem, echoId), { recursive: true });

    const writeEntries = (file: string, entries: object[]): void => {
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    };
    writeEntries(nestedFile, [
      { type: "session", id: "nested-root", parentId: null, timestamp: "2026-07-07T03:00:00Z" },
      {
        type: "message",
        id: "nested-answer",
        parentId: "nested-root",
        timestamp: "2026-07-07T03:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "Nested answer" }] },
      },
    ]);
    writeEntries(echoFile, [
      { type: "session", id: "echo-root", parentId: null, timestamp: "2026-07-07T02:00:00Z" },
      {
        type: "model_change",
        id: "echo-model",
        parentId: "echo-root",
        timestamp: "2026-07-07T02:00:00.500Z",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      },
      {
        type: "message",
        id: "echo-answer",
        parentId: "echo-model",
        timestamp: "2026-07-07T02:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "Found it" }] },
      },
      {
        type: "message",
        id: "nested-call",
        parentId: "echo-answer",
        timestamp: "2026-07-07T02:00:02Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "nested-task",
              name: "task",
              arguments: { agent: "task" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "nested-result",
        parentId: "nested-call",
        timestamp: "2026-07-07T02:00:03Z",
        message: {
          role: "toolResult",
          toolCallId: "nested-task",
          toolName: "task",
          content: [{ type: "text", text: "nested done" }],
          details: { results: [{ id: "NestedChild", exitCode: 0 }] },
        },
      },
    ]);
    writeEntries(failedFile, [
      { type: "session", id: "failed-root", parentId: null, timestamp: "2026-07-07T04:00:00Z" },
    ]);
    writeEntries(abortedFile, [
      { type: "session", id: "aborted-root", parentId: null, timestamp: 1_752_000_000 },
    ]);
    writeEntries(parentFile, [
      { type: "session", id: "parent-root", parentId: null, timestamp: "2026-07-07T01:00:00Z" },
      {
        type: "message",
        id: "task-call",
        parentId: "parent-root",
        timestamp: "2026-07-07T01:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "task-1", name: "task", arguments: { agent: "task" } }],
        },
      },
      {
        type: "message",
        id: "task-result",
        parentId: "task-call",
        timestamp: "2026-07-07T01:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: "task-1",
          toolName: "task",
          content: [{ type: "text", text: "batch done" }],
          details: {
            results: [
              { id: echoId, agent: "task", exitCode: 0 },
              { id: "FailedChild", exitCode: 2, error: "boom" },
              { id: "AbortedChild", aborted: true },
            ],
          },
        },
      },
    ]);

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile: parentFile, provider: "omp" })) {
      events.push(event);
    }
    const subagentEvents = events.flatMap((event) =>
      event.type === "provider_subagent" ? [event.event] : [],
    );
    expect(subagentEvents).toContainEqual({
      type: "timeline",
      id: echoId,
      timestamp: "2026-07-07T02:00:01Z",
      item: {
        type: "assistant_message",
        text: "Found it",
        messageId: "omp-history-assistant-1",
      },
    });
    expect(subagentEvents).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        id: "NestedChild",
        timestamp: "2026-07-07T03:00:01Z",
      }),
    );
    expect(subagentEvents.filter((event) => event.type === "upsert")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: echoId,
          title: "task · gpt-5.5 (openai-codex)",
          status: "running",
          timestamp: "2026-07-07T02:00:00Z",
        }),
        expect.objectContaining({
          id: echoId,
          title: "task · gpt-5.5 (openai-codex)",
          status: "completed",
          timestamp: "2026-07-07T02:00:03Z",
        }),
        expect.objectContaining({ id: "FailedChild", status: "failed" }),
        expect.objectContaining({ id: "AbortedChild", status: "canceled" }),
        expect.objectContaining({ id: "NestedChild", status: "completed" }),
      ]),
    );
  });
});
