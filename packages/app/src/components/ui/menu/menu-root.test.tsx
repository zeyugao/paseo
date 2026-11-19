/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { Text, View } from "react-native";
import { AppWindowCompactContext } from "@/hooks/app-window-frame-context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu-root";
import { useAnchoredPosition } from "./menu-overlay";

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <AppWindowCompactContext value={false}>
        <MenuRoot>
          <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
            <Text>Open</Text>
          </MenuTrigger>
        </MenuRoot>
      </AppWindowCompactContext>,
    );

    expect(triggerRef.current).not.toBeNull();
  });
});

describe("open menu placement", () => {
  it("places the same open menu above its moved trigger after a viewport resize", async () => {
    const viewportWidth = vi.spyOn(document.documentElement, "clientWidth", "get");
    const viewportHeight = vi.spyOn(document.documentElement, "clientHeight", "get");
    const updateViewport = (width: number, height: number) => {
      viewportWidth.mockReturnValue(width);
      viewportHeight.mockReturnValue(height);
      window.dispatchEvent(new Event("resize"));
    };
    const anchorRef = createRef<View>();
    render(<View ref={anchorRef} />);
    const anchor = anchorRef.current;
    if (!anchor) throw new Error("Menu anchor did not mount");
    const measurement = vi.spyOn(anchor, "measureInWindow");

    try {
      updateViewport(669, 951);
      measurement.mockImplementation((callback) => callback(285, 876, 44, 44));
      const { result } = renderHook(() =>
        useAnchoredPosition({
          open: true,
          anchorRect: null,
          anchorRef,
          side: "top",
          align: "start",
          offset: 4,
          scrollable: false,
        }),
      );
      act(() =>
        result.current.onContentLayout({ nativeEvent: { layout: { width: 220, height: 184 } } }),
      );
      await waitFor(() => expect(result.current.position).toEqual({ left: 285, bottomEdge: 872 }));

      measurement.mockImplementation((callback) => callback(337, 598, 44, 44));
      act(() => updateViewport(951, 669));
      await waitFor(() => expect(result.current.position).toEqual({ left: 337, bottomEdge: 594 }));
    } finally {
      measurement.mockRestore();
      viewportWidth.mockRestore();
      viewportHeight.mockRestore();
      act(() => window.dispatchEvent(new Event("resize")));
    }
  });
});
