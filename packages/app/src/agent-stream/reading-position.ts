import { z } from "zod";

export const savedReadingPositionSchema = z.strictObject({
  agentId: z.string().min(1),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  rowId: z.string().min(1),
  viewOffset: z.number().finite(),
  expandedTurnHostIds: z.array(z.string()),
  expandedUserMessageIds: z.array(z.string()),
  toolCallExpansion: z.strictObject({
    calls: z.record(z.string(), z.boolean()),
    groups: z.array(z.string()),
  }),
});

export type SavedReadingPosition = z.infer<typeof savedReadingPositionSchema>;
export type CapturedReadingPosition = Omit<
  SavedReadingPosition,
  "expandedTurnHostIds" | "expandedUserMessageIds" | "toolCallExpansion"
>;

export interface ReadingPositionPersistence {
  initial: SavedReadingPosition | null;
  save: (position: SavedReadingPosition | null) => void;
}
