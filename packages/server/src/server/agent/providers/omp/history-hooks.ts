import type { OmpHistoryMapperHooks } from "./message-history.js";
import { mapOmpAdvisorMessageToToolCall } from "./advisor-message.js";
import { mapOmpIrcMessageToToolCall } from "./irc-message.js";
import { mapOmpSystemNoticeToToolCalls } from "./system-notice.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { resolveOmpEmittedToolCallId } from "./tool-call-id.js";

export const OMP_HISTORY_MAPPER_HOOKS: OmpHistoryMapperHooks = {
  mapToolDetail: mapOmpToolDetail,
  mapCustomMessage: (message, text, provider) => {
    const item =
      mapOmpAdvisorMessageToToolCall(message, text) ?? mapOmpIrcMessageToToolCall(message, text);
    if (item) {
      return [{ type: "timeline", provider, item }];
    }
    return mapOmpSystemNoticeToToolCalls(message, text).map((notice) => ({
      type: "timeline" as const,
      provider,
      item: notice,
    }));
  },
  resolveToolCallId: resolveOmpEmittedToolCallId,
};
