import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import {
  savedReadingPositionSchema,
  type ReadingPositionPersistence,
  type SavedReadingPosition,
} from "@/agent-stream/reading-position";
import { usePanelState } from "./use-panel-state";

const agentReadingStateSchema = z.strictObject({
  readingPosition: savedReadingPositionSchema.nullable(),
});
const defaultAgentReadingState = { readingPosition: null };

export function useAgentReadingPosition(): ReadingPositionPersistence {
  const [state, setState] = usePanelState(agentReadingStateSchema, defaultAgentReadingState);
  // Saving must not change this mounted viewport's initial scroll target.
  const [initial] = useState(() => state.readingPosition);
  const save = useCallback(
    (readingPosition: SavedReadingPosition | null) => setState({ readingPosition }),
    [setState],
  );
  return useMemo(() => ({ initial, save }), [initial, save]);
}
