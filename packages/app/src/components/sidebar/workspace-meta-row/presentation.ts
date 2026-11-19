export const META_ROW_TEXT_COLLAPSE_ORDER = [
  "host",
  "plugin",
  "checks",
  "changeRequestState",
  "project",
  "labels",
  "services",
  "branch",
  "changeRequestNumber",
] as const;

export type MetaRowTextPriority = (typeof META_ROW_TEXT_COLLAPSE_ORDER)[number];

export interface MetaRowMeasuredField {
  id: string;
  priority: MetaRowTextPriority;
  width: number | null;
}

export interface MetaRowMeasuredItem {
  id: string;
  separator: boolean;
  fields: readonly MetaRowMeasuredField[];
}

export interface MetaRowPresentation {
  visibleTextIds: ReadonlySet<string>;
  separators: boolean;
  gap: number;
  wrap: boolean;
}

interface MetaRowPresentationInput {
  availableWidth: number;
  items: readonly MetaRowMeasuredItem[];
  markerWidth: number;
  separatorWidth: number | null;
  gap: number;
  compactGap: number;
}

export function selectMetaRowPresentation({
  availableWidth,
  items,
  markerWidth,
  separatorWidth,
  gap,
  compactGap,
}: MetaRowPresentationInput): MetaRowPresentation {
  const visibleTextIds = new Set<string>();
  const fields: MetaRowMeasuredField[] = [];
  let textWidth = 0;
  let separatorCount = 0;
  let fullyMeasured = true;
  for (const item of items) {
    if (item.separator) separatorCount += 1;
    for (const field of item.fields) {
      if (field.width === null) {
        fullyMeasured = false;
        continue;
      }
      fields.push(field);
      visibleTextIds.add(field.id);
      textWidth += field.width;
    }
  }
  const markerTotal = items.length * markerWidth;
  const gapCount = Math.max(0, items.length - 1);
  const fullSpacing = gapCount * gap + separatorCount * (gap + (separatorWidth ?? 0));
  const fullWidth = markerTotal + textWidth + fullSpacing;
  const fullPresentationFits =
    fullyMeasured && separatorWidth !== null && fullWidth <= availableWidth;
  if (fullPresentationFits) {
    return { visibleTextIds, separators: true, gap, wrap: false };
  }

  // Compact spacing is fixed: changing it at intermediate text thresholds would allow a
  // narrower row to regain a word that a wider row had already hidden.
  let compactWidth = markerTotal + textWidth + gapCount * compactGap;
  for (const priority of META_ROW_TEXT_COLLAPSE_ORDER) {
    if (compactWidth <= availableWidth) break;
    for (let index = fields.length - 1; index >= 0; index -= 1) {
      if (compactWidth <= availableWidth) break;
      const field = fields[index];
      if (field.priority !== priority) continue;
      visibleTextIds.delete(field.id);
      compactWidth -= field.width ?? 0;
    }
  }
  const markersNeedWrap = markerTotal + gapCount * compactGap > availableWidth;
  return {
    visibleTextIds,
    separators: false,
    gap: compactGap,
    wrap: availableWidth > 0 && markersNeedWrap,
  };
}
