import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceActionPlacement,
  resolveSidebarNavigationPlacement,
  resolveSafeAreaInsets,
  type WindowLayout,
} from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(input: Partial<WindowLayout> = {}): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    hingeStatus: "unavailable",
    verticalBarEdge: "none",
    verticalBar: null,
    divisions: [],
    ...input,
  };
}

describe("resolveWorkspaceActionPlacement", () => {
  it.each(["leading", "trailing"] as const)("uses a resolved %s native guide", (edge) => {
    const geometry = layout({
      verticalBarEdge: edge,
      verticalBar: { x: 17, y: 91, width: 44, height: 600 },
    });
    expect(resolveWorkspaceActionPlacement(geometry)).toBe("vertical-bar");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBar: null })).toBe("header");
    expect(resolveWorkspaceActionPlacement({ ...geometry, verticalBarEdge: "none" })).toBe(
      "header",
    );
  });

  it("keeps workspace actions in the header before native geometry arrives", () => {
    expect(resolveWorkspaceActionPlacement(null)).toBe("header");
  });
});

describe("resolveSidebarNavigationPlacement", () => {
  it.each([
    { edge: "trailing" as const, fillsDisplay: true, compact: false, expected: "header" },
    { edge: "trailing" as const, fillsDisplay: false, compact: false, expected: "vertical-bar" },
    { edge: "trailing" as const, fillsDisplay: true, compact: true, expected: "vertical-bar" },
    { edge: "trailing" as const, fillsDisplay: false, compact: true, expected: "vertical-bar" },
    { edge: "leading" as const, fillsDisplay: true, compact: false, expected: "vertical-bar" },
    { edge: "leading" as const, fillsDisplay: false, compact: true, expected: "vertical-bar" },
  ])(
    "places navigation for $edge full=$fillsDisplay compact=$compact",
    ({ edge, fillsDisplay, compact, expected }) => {
      const geometry = layout({
        fillsDisplay,
        verticalBarEdge: edge,
        verticalBar: { x: 17, y: 91, width: 44, height: 600 },
      });
      expect(resolveSidebarNavigationPlacement(geometry, compact)).toBe(expected);
    },
  );

  it("keeps navigation in the header without a resolved native bar", () => {
    expect(resolveSidebarNavigationPlacement(null, false)).toBe("header");
    expect(resolveSidebarNavigationPlacement(layout(), true)).toBe("header");
  });
});

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: 24 }))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: 0 })).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: value }))).toBe(
      systemInsets,
    );
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });

  it.each([
    { edge: "leading" as const, inset: 0, expected: 70 },
    { edge: "leading" as const, inset: 100, expected: 100 },
    { edge: "trailing" as const, inset: 0, expected: 70 },
    { edge: "trailing" as const, inset: 100, expected: 100 },
  ])(
    "clears a $edge bar without shrinking a larger inset ($inset)",
    ({ edge, inset, expected }) => {
      const leading = edge === "leading";
      const insets = {
        top: 0,
        right: leading ? 0 : inset,
        bottom: 34,
        left: leading ? inset : 0,
      };
      const geometry = layout({
        bounds: { x: 0, y: 0, width: 469, height: 669 },
        insets,
        verticalBarEdge: edge,
        verticalBar: { x: leading ? 26 : 399, y: 16, width: 44, height: 619 },
      });
      expect(resolveSafeAreaInsets(insets, geometry)).toEqual({
        ...insets,
        left: leading ? expected : 0,
        right: leading ? 0 : expected,
      });
    },
  );

  it("uses the measured top band instead of the rectangular safe area", () => {
    const insets = resolveSafeAreaInsets(
      systemInsets,
      layout({
        bounds: { x: 0, y: 0, width: 874, height: 402 },
        topBand: { top: 12, trailingObstruction: null },
      }),
    );
    expect(insets).toEqual({ ...systemInsets, top: 12 });
  });

  it("keeps the system top when there is no usable top band", () => {
    const insets = resolveSafeAreaInsets(
      systemInsets,
      layout({
        bounds: { x: 0, y: 0, width: 874, height: 402 },
        topBand: null,
      }),
    );
    expect(insets).toBe(systemInsets);
  });

  it("holds portrait padding while an independent safe-area event reaches landscape first", () => {
    const portrait = layout({
      bounds: { x: 0, y: 0, width: 669, height: 951 },
      insets: { top: 82, right: 0, bottom: 34, left: 0 },
      bottomClearance: 26,
      topBand: { top: 26, trailingObstruction: { width: 144, height: 56 } },
    });
    const landscapeInsets = { top: 0, right: 84, bottom: 34, left: 0 };
    expect(resolveSafeAreaInsets(landscapeInsets, portrait)).toEqual({
      top: 26,
      right: 0,
      bottom: 26,
      left: 0,
    });
  });

  it("uses landscape padding and removes the top band before the safe-area provider catches up", () => {
    const landscape = layout({
      bounds: { x: 0, y: 0, width: 951, height: 669 },
      insets: { top: 0, right: 84, bottom: 34, left: 0 },
      verticalBarEdge: "trailing",
      verticalBar: { x: 881, y: 124, width: 44, height: 511 },
      bottomClearance: 26,
      topBand: null,
    });
    const portraitInsets = { top: 82, right: 0, bottom: 34, left: 0 };
    expect(resolveSafeAreaInsets(portraitInsets, landscape)).toEqual({
      top: 0,
      right: 84,
      bottom: 26,
      left: 0,
    });
  });

  it("removes old landscape right padding as soon as portrait geometry arrives", () => {
    const oldInsets = { top: 0, right: 84, bottom: 26, left: 0 };
    const portrait = layout({
      bounds: { x: 0, y: 0, width: 669, height: 951 },
      insets: { top: 82, right: 0, bottom: 34, left: 0 },
      bottomClearance: 26,
    });
    expect(resolveSafeAreaInsets(oldInsets, portrait)).toEqual({
      top: 82,
      right: 0,
      bottom: 26,
      left: 0,
    });
  });

  it("moves an asymmetric inset between physical edges even without a bounds change", () => {
    const oldInsets = { top: 0, right: 84, bottom: 26, left: 0 };
    const leadingBar = layout({
      insets: { top: 0, right: 0, bottom: 34, left: 84 },
      verticalBarEdge: "leading",
      bottomClearance: 0,
    });
    expect(resolveSafeAreaInsets(oldInsets, leadingBar)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 84,
    });
  });
});
