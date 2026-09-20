import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

export function shouldDisplayOmpCustomMessage(message: OmpCustomMessage): boolean {
  return Reflect.get(message, "display") !== false;
}

// injected rows need their own message id so the stream coalescer never glues them
// onto the assistant reply they arrive next to
export function ompCustomMessageId(message: OmpCustomMessage, nextIndex: () => number): string {
  const id = Reflect.get(message, "id");
  return `omp-custom-${typeof id === "string" && id ? id : nextIndex()}`;
}

// omp does not persist the typed /skill:<name> as a user message, only the expansion
// it injected on the user's behalf; rebuild the bubble from the expansion's details
export function ompSkillPromptUserText(message: OmpCustomMessage): string | null {
  if (
    Reflect.get(message, "customType") !== "skill-prompt" ||
    Reflect.get(message, "attribution") !== "user"
  ) {
    return null;
  }
  const details = Reflect.get(message, "details");
  const name = details && typeof details === "object" ? Reflect.get(details, "name") : undefined;
  if (typeof name !== "string" || !name) {
    return null;
  }
  const args = Reflect.get(details as object, "args");
  return typeof args === "string" && args.trim()
    ? `/skill:${name} ${args.trim()}`
    : `/skill:${name}`;
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
    ...(typeof entry.id === "string" ? { id: entry.id } : {}),
  } as OmpCustomMessage;
}
