import { describe, expect, it } from "vitest";
import { resolveBottomOverlayTailInset } from "./bottom-overlay-inset";
import { resolveComposerTrackTailClearance } from "@/composer/pill-styles";

describe("resolveBottomOverlayTailInset", () => {
  it("adds only the space missing after existing footer clearance", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 24,
      }),
    ).toBe(32);
  });

  it("reserves the full overlay and clearance when the tail has no spacing", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 0,
      }),
    ).toBe(56);
  });

  it("reclaims the reserved row when the final composer pill disappears", () => {
    const visibleClearance = resolveComposerTrackTailClearance({
      isCompact: true,
      contentHeight: 32,
    });
    const emptyClearance = resolveComposerTrackTailClearance({ isCompact: true, contentHeight: 0 });
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: visibleClearance,
        existingTailSpacing: 24,
      }),
    ).toBe(40);
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: emptyClearance,
        existingTailSpacing: 24,
      }),
    ).toBe(0);
  });

  it("keeps taller pill content clear of the final footer", () => {
    const clearance = resolveComposerTrackTailClearance({ isCompact: true, contentHeight: 48 });
    expect(
      resolveBottomOverlayTailInset({ requiredTailClearance: clearance, existingTailSpacing: 24 }),
    ).toBe(56);
  });
});
