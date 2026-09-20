import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import type { OmpAgentMessage } from "./rpc-types.js";
import { isOmpSystemNotice, mapOmpSystemNoticeToToolCalls } from "./system-notice.js";

const COMPLETED_NOTICE = [
  "<system-notice>",
  "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
  '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
  '<meta lines="22" size="2.5KB" />',
  "<output>",
  '{"summary":"docs smoke check done"}',
  "</output>",
  "</task-result>",
  "</system-notice>",
  "DocsSmokeTwo is now idle — transcript at history://DocsSmokeTwo",
].join("\n");

const PARALLEL_JOBS_NOTICE = [
  "<system-notice>",
  "2 background jobs have completed. Resume your work using the results below.",
  "",
  "── Job FixBuild (FixBuild) ──",
  '<task-result id="FixBuild" agent="task" status="completed" duration="5m55s">',
  "<output>build ok</output>",
  "</task-result>",
  "── Job Sweep2161 (Sweep2161) ──",
  '<task-result id="Sweep2161" agent="scout" status="failed" duration="6m59s">',
  "<output>sweep blew up</output>",
  "</task-result>",
  "</system-notice>",
].join("\n");

function customMessage(content: string, id?: string): Extract<OmpAgentMessage, { role: "custom" }> {
  return { role: "custom", content, ...(id ? { id } : {}) };
}

function noticeStatusRow(status: string | null): Record<string, unknown> | undefined {
  const taskResult = status === null ? "" : ` status="${status}"`;
  const notice = [
    "<system-notice>",
    "Background job bg_1 has finished.",
    `<task-result id="bg_1"${taskResult}>`,
    "<output>done</output>",
    "</task-result>",
    "</system-notice>",
  ].join("\n");
  return mapOmpSystemNoticeToToolCalls(customMessage(notice), notice)[0];
}

describe("omp system notice detection", () => {
  test("detects messages that start with the system-notice tag", () => {
    expect(isOmpSystemNotice(COMPLETED_NOTICE)).toBe(true);
    expect(isOmpSystemNotice("  \n<system-notice>plain</system-notice>")).toBe(true);
  });

  test("ignores regular prompts, including ones that mention the tag mid-message", () => {
    const prompt = "what does <system-notice> mean in omp?";
    expect(isOmpSystemNotice("please fix the bug")).toBe(false);
    expect(isOmpSystemNotice(prompt)).toBe(false);
    expect(mapOmpSystemNoticeToToolCalls(customMessage(prompt), prompt)).toEqual([]);
  });
});

describe("omp system notice tool-call mapping", () => {
  test("maps a completed task-result notice to one collapsed row", () => {
    expect(
      mapOmpSystemNoticeToToolCalls(customMessage(COMPLETED_NOTICE, "notice-1"), COMPLETED_NOTICE),
    ).toEqual([
      {
        type: "tool_call",
        callId: "omp-notice:notice-1",
        name: "system_notice",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Background job DocsSmokeTwo completed",
          text: [
            "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
            '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
            '<meta lines="22" size="2.5KB" />',
            "<output>",
            '{"summary":"docs smoke check done"}',
            "</output>",
            "</task-result>",
            "",
            "DocsSmokeTwo is now idle — transcript at history://DocsSmokeTwo",
          ].join("\n"),
          icon: "bot",
        },
        metadata: { synthetic: true, source: "omp_system_notice" },
        error: null,
      },
    ]);
  });

  test("gives each job in a parallel payload its own row and status", () => {
    const rows = mapOmpSystemNoticeToToolCalls(
      customMessage(PARALLEL_JOBS_NOTICE, "notice-2"),
      PARALLEL_JOBS_NOTICE,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      callId: "omp-notice:notice-2#0",
      status: "completed",
      detail: { label: "Background job FixBuild completed" },
      error: null,
    });
    expect(rows[1]).toMatchObject({
      callId: "omp-notice:notice-2#1",
      status: "failed",
      detail: { label: "Background job Sweep2161 failed" },
      error: "sweep blew up",
    });
    // Each row carries the marker line that introduces its own job, and the
    // header text stays with the first row instead of repeating.
    expect(rows[0]?.detail.type === "plain_text" ? rows[0].detail.text : "").toContain(
      "── Job FixBuild (FixBuild) ──",
    );
    expect(rows[1]?.detail.type === "plain_text" ? rows[1].detail.text : "").toContain(
      "── Job Sweep2161 (Sweep2161) ──",
    );
    expect(rows[1]?.detail.type === "plain_text" ? rows[1].detail.text : "").not.toContain(
      "2 background jobs have completed",
    );
  });

  test("maps job statuses to row statuses", () => {
    const cases: Array<[string | null, string]> = [
      ["failed", "failed"],
      ["error", "failed"],
      ["canceled", "canceled"],
      ["cancelled", "canceled"],
      ["stopped", "canceled"],
      [null, "completed"],
      ["running", "completed"],
    ];
    for (const [input, expected] of cases) {
      expect(noticeStatusRow(input)).toMatchObject({ status: expected });
    }
  });

  test("reports a failed row's reason from its own output block", () => {
    const notice = [
      "<system-notice>",
      "Background job RepoSmokeOne has failed.",
      '<task-result id="RepoSmokeOne" agent="explore" status="failed" duration="3s">',
      "<output>boom</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    expect(mapOmpSystemNoticeToToolCalls(customMessage(notice), notice)).toMatchObject([
      { status: "failed", error: "boom", detail: { label: "Background job RepoSmokeOne failed" } },
    ]);
  });

  test("falls back to the row label when a failed row has no output block", () => {
    const notice = [
      "<system-notice>",
      "Background job RepoSmokeOne has failed.",
      '<task-result id="RepoSmokeOne" status="failed">',
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    expect(mapOmpSystemNoticeToToolCalls(customMessage(notice), notice)).toMatchObject([
      { status: "failed", error: "Background job RepoSmokeOne failed" },
    ]);
  });

  test("parses task-result attributes with typographic quotes", () => {
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed.",
      "<task-result id=“DocsSmokeTwo” agent=“explore” status=“completed” duration=“21.6s”>",
      "<output>ok</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    expect(mapOmpSystemNoticeToToolCalls(customMessage(notice), notice)).toMatchObject([
      { status: "completed", detail: { label: "Background job DocsSmokeTwo completed" } },
    ]);
  });

  test("maps a notice without a task-result using its first line", () => {
    const notice = "<system-notice>\nThe daemon rotated its logs.\n</system-notice>";

    const first = mapOmpSystemNoticeToToolCalls(customMessage(notice), notice);
    const second = mapOmpSystemNoticeToToolCalls(customMessage(notice), notice);
    expect(first).toEqual(second);
    expect(first).toMatchObject([
      {
        callId: expect.stringMatching(/^omp-notice:[0-9a-f]{12}$/),
        status: "completed",
        detail: { type: "plain_text", label: "The daemon rotated its logs.", icon: "bot" },
      },
    ]);
  });

  test("keeps the job identity when a payload is truncated mid-result", () => {
    const notice = [
      "<system-notice>",
      "1 background job has failed. Resume your work using the result below.",
      '<task-result id="LongJob" status="failed">',
      "<output>partial failure text",
    ].join("\n");

    expect(mapOmpSystemNoticeToToolCalls(customMessage(notice), notice)).toMatchObject([
      { status: "failed", detail: { label: "Background job LongJob failed" } },
    ]);
  });

  test("reads a CRLF payload without dropping content", () => {
    const notice = [
      "<system-notice>",
      "Background job bg_7 has completed.",
      '<task-result id="bg_7" status="completed">',
      "<output>ok</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\r\n");

    const rows = mapOmpSystemNoticeToToolCalls(customMessage(notice), notice);
    expect(rows).toMatchObject([
      { status: "completed", detail: { label: "Background job bg_7 completed" } },
    ]);
    const text = rows[0]?.detail.type === "plain_text" ? rows[0].detail.text : "";
    expect(text).toContain("<output>ok</output>");
  });

  test("renders an empty wrapper as a label-only row", () => {
    const notice = "<system-notice></system-notice>";

    expect(mapOmpSystemNoticeToToolCalls(customMessage(notice, "notice-empty"), notice)).toEqual([
      {
        type: "tool_call",
        callId: "omp-notice:notice-empty",
        name: "system_notice",
        status: "completed",
        detail: { type: "plain_text", label: "System notice", text: "", icon: "bot" },
        metadata: { synthetic: true, source: "omp_system_notice" },
        error: null,
      },
    ]);
  });
});

describe("omp system notice wire contract", () => {
  test("rows for every status satisfy the timeline wire schema", () => {
    const rows = ["completed", "failed", "canceled"].map((status) => {
      const notice = [
        "<system-notice>",
        `Background job bg_1 has ${status}.`,
        `<task-result id="bg_1" status="${status}">`,
        "<output>boom</output>",
        "</task-result>",
        "</system-notice>",
      ].join("\n");
      return mapOmpSystemNoticeToToolCalls(customMessage(notice, `notice-${status}`), notice)[0];
    });

    // Clients parse timeline items with this schema; the failed branch rejects
    // a null error, which a hand-built item would otherwise ship.
    for (const row of rows) {
      expect(AgentTimelineItemPayloadSchema.parse(row)).toEqual(row);
    }
  });
});
