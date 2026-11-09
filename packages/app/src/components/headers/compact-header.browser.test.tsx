import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { afterEach, describe, expect, it } from "vitest";
import { CompactHeaderTitle } from "./compact-header";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const titleSlots = [{ width: 160 }, { width: 48 }];
const projectRow = <Text>zeyugao/paseo</Text>;

function TitleSlots() {
  return titleSlots.map((style) => (
    <View key={style.width} style={style}>
      <CompactHeaderTitle
        loading={false}
        title="Paseo Duo Dev"
        titleTestID={`title-${style.width}`}
        subtitle={projectRow}
        fadeOverflow
        workspaceRow
      />
    </View>
  ));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function primaryTitle(testID: string): HTMLElement {
  const title = container?.querySelector(`[data-testid="${testID}"]`);
  if (!(title instanceof HTMLElement)) throw new Error(`Missing title ${testID}`);
  return title;
}

function mountTitles() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // ResizeObserver/onLayout has not delivered measurements during this synchronous commit.
  flushSync(() => root?.render(<TitleSlots />));
}

describe("fading workspace title first paint", () => {
  it("lays out both fitting and clipped titles before native layout callbacks", () => {
    mountTitles();

    const fitting = primaryTitle("title-160");
    const clipped = primaryTitle("title-48");
    expect(fitting.parentElement?.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      fitting.getBoundingClientRect().width,
    );
    expect(clipped.parentElement?.getBoundingClientRect().width).toBe(48);
    expect(fitting.getBoundingClientRect().width).toBeLessThan(160);
    expect(fitting.getBoundingClientRect().width).toBeGreaterThan(48);
    expect(clipped.getBoundingClientRect().width).toBe(48);
  });

  it("fades only clipped text after its natural width is measured", async () => {
    mountTitles();
    await expect
      .poll(() => container?.querySelector('[data-testid="title-48-fade"]'))
      .not.toBeNull();
    const fade = primaryTitle("title-48-fade").getBoundingClientRect();
    const title = primaryTitle("title-48").getBoundingClientRect();
    expect(fade.right).toBe(title.right);
    expect(fade.left).toBeGreaterThanOrEqual(title.left);
    expect(fade.left).toBeLessThan(fade.right);
    expect(container?.querySelector('[data-testid="title-160-fade"]')).toBeNull();
  });
});
