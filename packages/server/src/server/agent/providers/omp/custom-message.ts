import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

export function shouldDisplayOmpCustomMessage(message: OmpCustomMessage): boolean {
  return Reflect.get(message, "display") !== false;
}

/**
 * Session-level `custom_message` entries carry the same payload as live custom
 * messages. Rebuild one so replay maps them the way the live stream does: hidden
 * entries stay hidden and system notices become notifications.
 */
export function mapOmpCustomMessageEntry(entry: Record<string, unknown>): OmpCustomMessage | null {
  if (typeof entry.content !== "string" && !Array.isArray(entry.content)) {
    return null;
  }
  return {
    role: "custom",
    content: entry.content,
    ...(typeof entry.customType === "string" ? { customType: entry.customType } : {}),
    ...(typeof entry.display === "boolean" ? { display: entry.display } : {}),
  } as OmpCustomMessage;
}
