import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { readOmpNativeMessageId } from "./native-message-id.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;
type OmpIrcToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

interface OmpIrcBlock {
  sender: string | null;
  body: string;
}

const IRC_BLOCK_PATTERN = /<irc>([\s\S]*?)<\/irc>/g;
const IRC_STRAY_TAG_PATTERN = /<\/?irc>/g;
const IRC_SENDER_PATTERN = /^Incoming IRC message from agent\s+`([^`]+)`\s*:?\s*/;

function parseIrcBlock(inner: string): OmpIrcBlock | null {
  // Wrapper tags carry no meaning once a segment is a block, and a stray one
  // left in the body would render as literal `<irc>` text in the row.
  const trimmed = inner.replace(IRC_STRAY_TAG_PATTERN, "").trim();
  if (!trimmed) {
    return null;
  }
  const senderMatch = trimmed.match(IRC_SENDER_PATTERN);
  if (!senderMatch) {
    return { sender: null, body: trimmed };
  }
  const body = trimmed.slice(senderMatch[0].length).trim();
  return { sender: senderMatch[1] ?? null, body: body || trimmed };
}

/**
 * One `irc:incoming` payload can carry several queued messages, and a payload
 * can be cut off mid-block when the harness truncates it. Walk the text once so
 * every non-empty segment becomes a block: content between or after complete
 * blocks is parsed as the next (possibly truncated) block instead of dropped.
 */
function parseIrcBlocks(text: string): OmpIrcBlock[] {
  const blocks: OmpIrcBlock[] = [];
  let cursor = 0;
  for (const match of text.matchAll(IRC_BLOCK_PATTERN)) {
    const index = match.index ?? cursor;
    if (index > cursor) {
      const gap = parseIrcBlock(text.slice(cursor, index));
      if (gap) {
        blocks.push(gap);
      }
    }
    const block = parseIrcBlock(match[1] ?? "");
    if (block) {
      blocks.push(block);
    }
    cursor = index + match[0].length;
  }
  const tail = parseIrcBlock(text.slice(cursor));
  if (tail) {
    blocks.push(tail);
  }
  return blocks;
}

/**
 * Incoming IRC traffic arrives as a `custom_message`, which would otherwise
 * render as assistant prose with the `<irc>` wrapper visible. Map it to a
 * synthetic tool call so it reads as an inbound row that expands on demand.
 */
export function mapOmpIrcMessageToToolCall(
  message: OmpCustomMessage,
  text: string,
): OmpIrcToolCallItem | null {
  if (Reflect.get(message, "customType") !== "irc:incoming") return null;

  const blocks = parseIrcBlocks(text);
  const onlyBlock = blocks.length === 1 ? blocks[0] : undefined;

  let label: string | undefined;
  let body: string | undefined;
  if (onlyBlock) {
    label = onlyBlock.sender ? `From \`${onlyBlock.sender}\`` : "Incoming message";
    body = onlyBlock.body;
  } else if (blocks.length > 1) {
    label = `${blocks.length} messages`;
    body = blocks
      .map((block) => (block.sender ? `From \`${block.sender}\`\n\n${block.body}` : block.body))
      .join("\n\n");
  } else {
    label = "Incoming message";
  }

  const nativeId = readOmpNativeMessageId(message);
  const callId =
    nativeId !== undefined
      ? `omp-irc:${nativeId}`
      : `omp-irc:${createHash("sha1").update(text.trim()).digest("hex").slice(0, 12)}`;

  return {
    type: "tool_call",
    callId,
    name: "irc",
    status: "completed",
    detail: {
      type: "plain_text",
      ...(label ? { label } : {}),
      ...(body ? { text: body } : {}),
      icon: "bot",
    },
    metadata: {
      synthetic: true,
      source: "omp_irc",
      messageCount: blocks.length,
    },
    error: null,
  };
}
