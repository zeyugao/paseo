import type { StreamItem, TimelinePosition } from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

/**
 * A turn ends on an assistant message, or on the error notification Paseo
 * writes when the provider run fails. Both anchor "fork chat from here", and
 * neither carries a provider message id on every host.
 */
export function isForkableTurnEnd(item: StreamItem): boolean {
  if (item.kind === "assistant_message") {
    return true;
  }
  return item.kind === "notification" && item.sourceType === "error";
}

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const item = input.items[input.startIndex];
  if (!item || !isForkableTurnEnd(item)) {
    return undefined;
  }
  const messageId = item.kind === "assistant_message" ? item.messageId : undefined;
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(messageId ? { boundaryMessageId: messageId } : {}),
    };
  }
  return messageId ? { boundaryMessageId: messageId } : undefined;
}
