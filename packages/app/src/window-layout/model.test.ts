import { describe, expect, it } from "vitest";
import { resolveSafeAreaInsets, type WindowLayout } from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(bottomClearance: number | null | undefined): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    insets: systemInsets,
    verticalBarEdge: "none",
    verticalBar: null,
    bottomClearance,
    divisions: [],
  };
}

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(24))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(0)).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout(value))).toBe(systemInsets);
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });

  it("uses the landscape scene insets before the safe-area provider catches up", () => {
    const landscape: WindowLayout = {
      ...layout(26),
      bounds: { x: 0, y: 0, width: 951, height: 669 },
      insets: { top: 0, right: 84, bottom: 34, left: 0 },
      verticalBarEdge: "trailing",
      verticalBar: { x: 881, y: 124, width: 44, height: 511 },
    };
    expect(resolveSafeAreaInsets(systemInsets, landscape)).toEqual({
      top: 0,
      right: 84,
      bottom: 26,
      left: 0,
    });
  });

  it("removes the old landscape clearance when the portrait scene arrives", () => {
    const oldInsets = { top: 0, right: 84, bottom: 26, left: 0 };
    const portrait = { ...layout(26), insets: { top: 82, right: 0, bottom: 34, left: 0 } };
    expect(resolveSafeAreaInsets(oldInsets, portrait)).toEqual({
      top: 82,
      right: 0,
      bottom: 26,
      left: 0,
    });
  });
});
