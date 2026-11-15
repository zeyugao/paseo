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
  /** Where a top bar rests, or null until the system resolves its top bar guide. */
  topBar?: WindowLayoutRect | null;
  /** Usable first row beside one corner occlusion, retained while the status bar is hidden. */
  topChrome?: (WindowLayoutRect & { cornerLeft: number; cornerRight: number }) | null;
  /** Rounded-corner clearance at the first header row, independent of reusable top chrome. */
  headerCornerInsets?: { left: number; right: number } | null;
  /** True only after this scene's native status-bar hide transition completes. */
  statusBarHidden?: boolean;
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
  /** Rounded-corner / system clearance for controls at the physical left edge only. */
  leadingInset?: number;
  /**
   * The system region past the bar's trailing end, measured from the band's top, or null
   * when the bar reaches the window's trailing edge.
   */
  trailingObstruction: { width: number; height: number } | null;
}

/** Prefer the reusable window-edge row; otherwise use UIKit's inset top bar guide. */
export function resolveTopBand(
  systemTop: number,
  layout: WindowLayout | null,
  statusBarHidden = false,
): TopBand | null {
  const chrome = layout?.topChrome;
  if (layout && chrome) {
    const hidden = statusBarHidden && layout.statusBarHidden === true;
    const width = Math.ceil(
      hidden ? chrome.cornerRight : layout.bounds.width - chrome.x - chrome.width,
    );
    return {
      top: chrome.y,
      leadingInset: Math.max(0, hidden ? chrome.cornerLeft : chrome.x),
      trailingObstruction: width > 0 ? { width, height: chrome.height } : null,
    };
  }
  const bar = layout?.topBar;
  if (!layout || !bar || bar.y >= (layout.insets?.top ?? systemTop)) return null;
  const top = Math.max(0, bar.y);
  const barEnd = bar.x + bar.width;
  const width = Math.ceil(layout.bounds.width - barEnd);
  if (width <= 0) return { top, trailingObstruction: null };
  const beside = (layout.occlusions ?? []).filter(
    (frame) => frame.x + frame.width > barEnd && frame.y < bar.y + bar.height,
  );
  const bottom = Math.max(bar.y + bar.height, ...beside.map((frame) => frame.y + frame.height));
  return { top, trailingObstruction: { width, height: Math.ceil(bottom - top) } };
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
  const top = resolveTopBand(insets.top, layout)?.top ?? insets.top;
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

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Horizontal safe area is already owned by the surface; only the remaining corner applies. */
export function resolveHeaderCornerInsets(
  layout: WindowLayout | null,
): { left: number; right: number } | null {
  const corners = layout?.headerCornerInsets;
  if (!corners) return null;
  const insets = resolveSafeAreaInsets(ZERO_INSETS, layout);
  return {
    left: Math.max(0, corners.left - insets.left),
    right: Math.max(0, corners.right - insets.right),
  };
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
