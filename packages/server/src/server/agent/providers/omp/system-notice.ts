import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { readOmpNativeMessageId } from "./native-message-id.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;
type OmpSystemNoticeToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

const SYSTEM_NOTICE_OPEN_TAG = "<system-notice>";
const SYSTEM_NOTICE_WRAPPER_TAG_PATTERN = /<\/?system-notice>/g;
const TASK_RESULT_TAG_PATTERN = /<task-result\b([^>]*)>/i;
const TASK_RESULT_BLOCK_PATTERN = /<task-result\b[^>]*>[\s\S]*?<\/task-result>/gi;
const TASK_RESULT_OUTPUT_PATTERN = /<output>([\s\S]*?)<\/output>/i;
// The omp harness emits straight quotes, but transcripts have been observed
// with typographic quotes after copy/paste round-trips; accept both.
const TASK_RESULT_ATTRIBUTE_PATTERN = /([\w-]+)=["'“‘]([^"'“”‘’]*)["'”’]/g;

interface OmpTaskResultSummary {
  id: string | null;
  agent: string | null;
  status: string | null;
}

interface OmpNoticeSegment {
  taskResult: OmpTaskResultSummary | null;
  raw: string;
}

type OmpSystemNoticeStatus = "completed" | "failed" | "canceled";

export function isOmpSystemNotice(text: string): boolean {
  return text.trimStart().startsWith(SYSTEM_NOTICE_OPEN_TAG);
}

// Wrapper tags carry no meaning once a row can expand, and a stray one left in
// the body would render as literal `<system-notice>` text; the `<task-result>`
// payload keeps its tags because they carry provenance (agent, status, duration).
function stripNoticeWrappers(text: string): string {
  return text.replace(SYSTEM_NOTICE_WRAPPER_TAG_PATTERN, "").trim();
}

function readTaskResult(text: string): OmpTaskResultSummary | null {
  const tagMatch = text.match(TASK_RESULT_TAG_PATTERN);
  if (!tagMatch) {
    return null;
  }
  const attributes = new Map<string, string>();
  for (const attributeMatch of (tagMatch[1] ?? "").matchAll(TASK_RESULT_ATTRIBUTE_PATTERN)) {
    const name = attributeMatch[1];
    const value = attributeMatch[2];
    if (name && value !== undefined) {
      attributes.set(name, value.trim());
    }
  }
  return {
    id: attributes.get("id") || null,
    agent: attributes.get("agent") || null,
    status: attributes.get("status") || null,
  };
}

function readNoticeFirstLine(text: string): string | null {
  for (const line of stripNoticeWrappers(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("<")) {
      return trimmed;
    }
  }
  return null;
}

function noticeStatus(taskResult: OmpTaskResultSummary | null): OmpSystemNoticeStatus {
  const status = taskResult?.status?.toLowerCase() ?? null;
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "canceled" || status === "cancelled" || status === "stopped") {
    return "canceled";
  }
  return "completed";
}

function buildLabel(taskResult: OmpTaskResultSummary | null, text: string): string {
  if (taskResult?.id) {
    return `Background job ${taskResult.id} ${taskResult.status ?? "completed"}`;
  }
  return readNoticeFirstLine(text) ?? "System notice";
}

/**
 * The harness reports several finished jobs in one payload — a header line,
 * then one `<task-result>` per job — so each result becomes its own row. The
 * header (or the `── Job X ──` marker) that precedes a result belongs to that
 * result's row, and text after the last result rides along with it.
 */
function parseNoticeSegments(text: string): OmpNoticeSegment[] {
  const blocks = [...text.matchAll(TASK_RESULT_BLOCK_PATTERN)];
  if (blocks.length === 0) {
    // A truncated payload has no complete block, but its opening tag still
    // carries the job's id and status.
    return [{ taskResult: readTaskResult(text), raw: stripNoticeWrappers(text) }];
  }

  const segments: OmpNoticeSegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const start = block.index ?? cursor;
    const end = start + block[0].length;
    const raw = stripNoticeWrappers(text.slice(cursor, end));
    if (raw) {
      segments.push({ taskResult: readTaskResult(block[0]), raw });
    }
    cursor = end;
  }

  const tail = stripNoticeWrappers(text.slice(cursor));
  if (!tail) {
    return segments;
  }
  // A payload cut off mid-job still names the job it was reporting.
  const tailResult = readTaskResult(tail);
  if (tailResult) {
    segments.push({ taskResult: tailResult, raw: tail });
    return segments;
  }
  const last = segments.at(-1);
  if (last) {
    last.raw = `${last.raw}\n\n${tail}`;
    return segments;
  }
  return [{ taskResult: null, raw: tail }];
}

function buildNoticeRow(input: {
  callId: string;
  label: string;
  raw: string;
  status: OmpSystemNoticeStatus;
  error: unknown;
}): OmpSystemNoticeToolCallItem {
  const base = {
    type: "tool_call" as const,
    callId: input.callId,
    name: "system_notice",
    detail: {
      type: "plain_text" as const,
      label: input.label,
      text: input.raw,
      icon: "bot" as const,
    },
    metadata: {
      synthetic: true,
      source: "omp_system_notice",
    },
  };
  // The wire schema requires a non-null error on failed rows, which the caller
  // fills from the job's own `<output>`.
  if (input.status === "failed") {
    return { ...base, status: "failed", error: input.error };
  }
  if (input.status === "canceled") {
    return { ...base, status: "canceled", error: null };
  }
  return { ...base, status: "completed", error: null };
}

/**
 * The harness reports background-job results and other housekeeping through
 * `<system-notice>` blocks that arrive as custom messages, which would otherwise
 * render as assistant prose. Map them to synthetic tool calls so the timeline
 * shows collapsed rows that expand to the full notice.
 */
export function mapOmpSystemNoticeToToolCalls(
  message: OmpCustomMessage,
  text: string,
): OmpSystemNoticeToolCallItem[] {
  if (!isOmpSystemNotice(text)) {
    return [];
  }

  const segments = parseNoticeSegments(text);
  const nativeId = readOmpNativeMessageId(message);
  return segments.map(({ taskResult, raw }, index) => {
    const status = noticeStatus(taskResult);
    const label = buildLabel(taskResult, raw);
    // A payload of parallel jobs keeps one row per job, so the row needs its own
    // identity; a single-result payload keeps the bare native id or content hash
    // that earlier rows were written with.
    const callId = nativeId
      ? `omp-notice:${nativeId}${segments.length > 1 ? `#${index}` : ""}`
      : `omp-notice:${createHash("sha1")
          .update(segments.length > 1 ? `${index}:${raw}` : text.trim())
          .digest("hex")
          .slice(0, 12)}`;
    const failure = raw.match(TASK_RESULT_OUTPUT_PATTERN)?.[1]?.trim();
    return buildNoticeRow({
      callId,
      label,
      raw,
      status,
      error: failure || label,
    });
  });
}
