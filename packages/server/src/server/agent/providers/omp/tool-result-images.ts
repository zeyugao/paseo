import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import {
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
  type ProviderImageOutput,
} from "../provider-image-output.js";
import { OmpImageContentSchema } from "./rpc-types.js";
import type { OmpToolResult } from "./tool-call-detail.js";

export function splitOmpToolResultImages(result: OmpToolResult): {
  result: OmpToolResult;
  images: ProviderImageOutput[];
} {
  const images: ProviderImageOutput[] = [];
  if (
    !result ||
    typeof result === "string" ||
    !result.content?.some((block) => block.type === "image")
  ) {
    return { result, images };
  }
  const content = result.content.map((block) => {
    if (block.type !== "image") return block;
    const parsed = OmpImageContentSchema.safeParse(block);
    if (parsed.success) images.push({ data: parsed.data.data, mimeType: parsed.data.mimeType });
    // Keep binary payloads out of every tool detail, including unknown tools and failures.
    return { type: "text" as const, text: "[image]" };
  });
  return { result: { ...result, content }, images };
}

export async function renderOmpToolResultImages(
  images: readonly ProviderImageOutput[],
): Promise<AgentTimelineItem[]> {
  const items: AgentTimelineItem[] = [];
  for (const image of images) {
    const item = await renderProviderImageOutputAsAssistantMarkdown(image, {
      materialize: materializeProviderImage,
    });
    if (item) items.push(item);
  }
  return items;
}
