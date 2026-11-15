import { describe, expect, it } from "vitest";
import { resolveSheetSnapPoint } from "./snap-points";

describe("percentage sheet top clearance", () => {
  it.each([
    { point: "95%", height: 669, topInset: 0, clearance: 33.45 },
    { point: "90%", height: 669, topInset: 0, clearance: 66.9 },
    { point: "95%", height: 669, topInset: 40, clearance: 40 },
    { point: "90%", height: 669, topInset: 40, clearance: 62.9 },
    { point: "95%", height: 669, topInset: 90, clearance: 90 },
    { point: "90%", height: 669, topInset: 90, clearance: 90 },
    { point: "90%", height: 660, topInset: 60, clearance: 60 },
    { point: "90%", height: 1200, topInset: 90, clearance: 111 },
    { point: "100%", height: 669, topInset: 90, clearance: 90 },
  ])(
    "leaves $clearance points for $point with a $topInset-point safe area",
    ({ point, height, topInset, clearance }) => {
      expect(resolveSheetSnapPoint(point, height, topInset)).toBeCloseTo(height - clearance);
    },
  );

  it("excludes the reserved bottom inset from usable height", () => {
    expect(resolveSheetSnapPoint("90%", 669, 40, 20)).toBeCloseTo(588.1);
  });

  it("keeps fixed-height snap points independent of percentage clearance", () => {
    expect(resolveSheetSnapPoint(300, 669, 90)).toBe(300);
  });
});
