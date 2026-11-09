export interface WindowLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout {
  bounds: WindowLayoutRect;
  insets: { top: number; right: number; bottom: number; left: number };
  verticalBarEdge: "none" | "leading" | "trailing";
  verticalBar: WindowLayoutRect | null;
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  divisions: WindowLayoutRect[];
  /** Usable first row beside one corner occlusion; retained while the status bar is hidden. */
  topChrome?: WindowLayoutRect | null;
}

export function resolveWorkspaceTopChromeInsets(
  layout: WindowLayout | null,
  insets: { top: number; left: number; right: number },
  edges: { left: boolean; right: boolean },
) {
  const bar = layout?.topChrome;
  if (!layout || !bar) return null;
  return {
    paddingTop: bar.y,
    paddingLeft: edges.left ? Math.max(0, bar.x - insets.left) : 0,
    paddingRight: edges.right
      ? Math.max(0, layout.bounds.width - insets.right - bar.x - bar.width)
      : 0,
  };
}

/** Scene geometry and insets move together; the bottom bar refines the system clearance. */
export function resolveSafeAreaInsets<Insets extends WindowLayout["insets"]>(
  systemInsets: Insets,
  layout: WindowLayout | null,
): Insets {
  const insets = layout?.insets ?? systemInsets;
  const bottom = layout?.bottomClearance ?? insets.bottom;
  return insets.top === systemInsets.top &&
    insets.right === systemInsets.right &&
    bottom === systemInsets.bottom &&
    insets.left === systemInsets.left
    ? systemInsets
    : { ...systemInsets, ...insets, bottom };
}

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

export function resolveWorkspaceActionPlacement(
  layout: WindowLayout | null,
): "header" | "vertical-bar" {
  return layout?.verticalBarEdge === "trailing" && layout.verticalBar !== null
    ? "vertical-bar"
    : "header";
}

export function resolveWorkspaceBarActions(
  headerVariant: "compact" | "full" | "inline",
): readonly ("tab-count" | "git" | "overflow" | "explorer")[] {
  if (headerVariant === "compact") return ["tab-count", "git", "overflow", "explorer"];
  return headerVariant === "inline" ? ["git", "overflow", "explorer"] : ["overflow", "explorer"];
}

/** One book-like partition owns allocation; horizontal folds retain the normal flow. */
export function resolveDesktopDivisionLayout(input: {
  geometry: WindowLayout | null;
  windowWidth: number;
  windowHeight: number;
  leftInset: number;
  rightInset: number;
}): DesktopDivisionLayout | null {
  const { geometry, windowWidth, windowHeight, leftInset, rightInset } = input;
  if (
    !geometry ||
    Math.abs(geometry.bounds.width - windowWidth) > 0.5 ||
    Math.abs(geometry.bounds.height - windowHeight) > 0.5
  )
    return null;
  const divisions = geometry.divisions.filter(
    (frame) =>
      frame.width > 0 &&
      frame.height > frame.width &&
      frame.y < windowHeight &&
      frame.y + frame.height > 0,
  );
  if (divisions.length !== 1) return null;
  const division = divisions[0];
  const sidebarWidth = division.x - leftInset;
  const contentWidth = windowWidth - rightInset - division.x - division.width;
  if (sidebarWidth <= 0 || contentWidth <= 0) return null;
  return { sidebarWidth, gap: division.width, contentWidth };
}
