export interface WindowLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout {
  bounds: WindowLayoutRect;
  /** Native hinge state for this view hierarchy; unavailable on displays without one. */
  hingeStatus: "unavailable" | "unknown" | "closed" | "partially-open" | "fully-open";
  /** Whether this window covers its entire display, rather than a system split or floating region. */
  fillsDisplay?: boolean;
  /** Rectangular safe area measured with these bounds and system-control guides. */
  insets?: { top: number; right: number; bottom: number; left: number };
  verticalBarEdge: "none" | "leading" | "trailing";
  verticalBar: WindowLayoutRect | null;
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  /** Usable top band resolved alongside the surface insets. */
  topBand?: TopBand | null;
  /** Residual rounded-corner and status-region clearance for the first row. */
  inlineChromeInsets?: { left: number; right: number };
  /** Mirrored clearance for undocked content on the full expanded display. */
  contentCenteringInsets?: { left: number; right: number } | null;
  /** Active system occlusions (status region, camera, Live Activities), margins included. */
  occlusions?: WindowLayoutRect[];
  divisions: WindowLayoutRect[];
}

/**
 * The band above the rectangular safe area that a top bar may use because the system
 * occupies only its trailing end, like window controls on a desktop title bar.
 */
export interface TopBand {
  /** Where the top bar starts, in window points. */
  top: number;
  /**
   * The system region past the bar's trailing end, measured from the band's top, or null
   * when the bar reaches the window's trailing edge.
   */
  trailingObstruction: { width: number; height: number } | null;
}

/**
 * Frame, insets and system controls share one native snapshot. The bar guides refine its
 * rectangular safe area without mixing insets from a separately timed provider event.
 */
export function resolveSafeAreaInsets<
  Insets extends { top: number; right?: number; bottom: number; left?: number },
>(systemInsets: Insets, layout: WindowLayout | null): Insets {
  const insets = layout?.insets ?? systemInsets;
  const clearance = layout?.bottomClearance;
  const bottom = typeof clearance === "number" ? clearance : insets.bottom;
  const top = layout?.topBand?.top ?? insets.top;
  // UIKit can report zero horizontal safe area beside a resolved leading bar.
  const bar = layout?.verticalBar;
  const left =
    bar && layout.verticalBarEdge === "leading"
      ? Math.max(insets.left ?? 0, bar.x + bar.width)
      : insets.left;
  const right =
    bar && layout.verticalBarEdge === "trailing"
      ? Math.max(insets.right ?? 0, layout.bounds.width - bar.x)
      : insets.right;
  return top === systemInsets.top &&
    right === systemInsets.right &&
    bottom === systemInsets.bottom &&
    left === systemInsets.left
    ? systemInsets
    : { ...systemInsets, ...insets, top, right, bottom, left };
}

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

export function resolveWorkspaceActionPlacement(
  layout: WindowLayout | null,
): "header" | "vertical-bar" {
  return layout?.verticalBar &&
    (layout.verticalBarEdge === "leading" || layout.verticalBarEdge === "trailing")
    ? "vertical-bar"
    : "header";
}

/** A full-width wide page keeps left navigation on its leading header edge. */
export function resolveSidebarNavigationPlacement(
  layout: WindowLayout | null,
  compact: boolean,
): "header" | "vertical-bar" {
  if (resolveWorkspaceActionPlacement(layout) !== "vertical-bar") return "header";
  return !compact && layout?.fillsDisplay === true && layout.verticalBarEdge === "trailing"
    ? "header"
    : "vertical-bar";
}

export function resolveWorkspaceBarActions(
  headerVariant: "compact" | "full" | "inline",
): readonly ("tab-count" | "git" | "overflow" | "explorer")[] {
  if (headerVariant === "compact") return ["tab-count", "overflow", "explorer"];
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
