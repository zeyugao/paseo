import { describe, expect, it } from "vitest";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import type { PrHint } from "@/git/pr-hint";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY } from "@/components/sidebar/display-preferences/checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import { selectMetaRowItems } from "./meta-items";
import { selectMetaRowPresentation, type MetaRowMeasuredItem } from "./presentation";
import type { WorkspaceServiceSummary } from "./service-summary";

const PR_HINT: PrHint = {
  url: "https://github.com/acme/app/pull/7",
  number: 7,
  state: "open",
  forge: "github",
  checksStatus: "success",
};

const SERVICE: WorkspaceServiceSummary = { name: "web", health: null };

const LABELS: WorkspaceLabelDefinition[] = [{ name: "Urgent", color: "red" }];

function select(overrides: Partial<Parameters<typeof selectMetaRowItems>[0]> = {}) {
  return selectMetaRowItems({
    currentBranch: "feature/sidebar-badges",
    projectName: "Paseo",
    hasHostBadge: true,
    prHint: PR_HINT,
    serviceSummary: SERVICE,
    labels: LABELS,
    visible: DEFAULT_SIDEBAR_ROW_ITEMS,
    checksDisplay: DEFAULT_SIDEBAR_CHECKS_DISPLAY,
    ...overrides,
  });
}

const kinds = (items: ReturnType<typeof selectMetaRowItems>) => items.map((item) => item.kind);

describe("selectMetaRowItems", () => {
  it("puts the enabled branch and project badges first", () => {
    const visible = { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true, project: true };
    expect(kinds(select({ visible }))).toEqual([
      "branch",
      "project",
      "host",
      "changeRequest",
      "checks",
      "services",
      "labels",
    ]);
  });

  it("reads identity, then the change, then its state, then what is running, then labels", () => {
    expect(kinds(select())).toEqual(["host", "changeRequest", "checks", "services", "labels"]);
  });

  it("omits what the workspace does not have", () => {
    expect(
      kinds(
        select({
          currentBranch: null,
          projectName: null,
          hasHostBadge: false,
          prHint: null,
          serviceSummary: null,
          labels: [],
        }),
      ),
    ).toEqual([]);
  });

  it("only draws identity badges when enabled and available", () => {
    const visible = { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true, project: true };
    expect(kinds(select({ currentBranch: null, projectName: null, visible }))).toEqual([
      "host",
      "changeRequest",
      "checks",
      "services",
      "labels",
    ]);
  });

  it("carries every label as one item, so the line keeps one separator however many there are", () => {
    const labels: WorkspaceLabelDefinition[] = [
      { name: "Urgent", color: "red" },
      { name: "Backend", color: "sky" },
    ];
    expect(select({ labels }).at(-1)).toEqual({ kind: "labels", labels });
  });

  it.each([
    ["changeRequest", ["host", "checks", "services", "labels"]],
    ["services", ["host", "changeRequest", "checks", "labels"]],
    ["labels", ["host", "changeRequest", "checks", "services"]],
  ] as const)("drops %s and only %s when it is switched off", (item, expected) => {
    expect(kinds(select({ visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, [item]: false } }))).toEqual(
      expected,
    );
  });

  it("drops checks and only checks when they are hidden", () => {
    expect(kinds(select({ checksDisplay: "none" }))).toEqual([
      "host",
      "changeRequest",
      "services",
      "labels",
    ]);
  });

  it("keeps checks when the change request is hidden", () => {
    // Each control answers for itself. A checks setting that drew nothing because a different
    // switch was off would be lying about its own state.
    const items = select({ visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false } });
    expect(kinds(items)).toEqual(["host", "checks", "services", "labels"]);
  });

  it("draws nothing for checks when both are off", () => {
    const items = select({
      visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false },
      checksDisplay: "none",
    });
    expect(kinds(items)).toEqual(["host", "services", "labels"]);
  });

  it("carries the resolved check summary rather than the raw hint", () => {
    const checks = select().find((item) => item.kind === "checks");
    expect(checks).toEqual({
      kind: "checks",
      summary: { state: "passed", completed: 1, total: 1 },
      label: true,
    });
  });

  it("keeps the check summary but drops its word when only the icon is wanted", () => {
    const checks = select({ checksDisplay: "icon" }).find((item) => item.kind === "checks");
    expect(checks).toEqual({
      kind: "checks",
      summary: { state: "passed", completed: 1, total: 1 },
      label: false,
    });
  });

  it("keeps a change request whose forge reports no checks", () => {
    const items = select({ prHint: { ...PR_HINT, checksStatus: undefined } });
    expect(kinds(items)).toEqual(["host", "changeRequest", "services", "labels"]);
  });
});

const MEASURED_ITEMS: readonly MetaRowMeasuredItem[] = [
  { id: "host", separator: false, fields: [{ id: "host", priority: "host", width: 88 }] },
  {
    id: "pr",
    separator: true,
    fields: [{ id: "number", priority: "changeRequestNumber", width: 33 }],
  },
  { id: "ci", separator: true, fields: [{ id: "checks", priority: "checks", width: 47 }] },
];

function present(availableWidth: number, items = MEASURED_ITEMS) {
  return selectMetaRowPresentation({
    availableWidth,
    items,
    markerWidth: 12,
    separatorWidth: 3,
    gap: 6,
    compactGap: 4,
  });
}

describe("metadata text priority", () => {
  it("restores all words and separators when the complete row fits", () => {
    expect(present(240)).toEqual({
      visibleTextIds: new Set(["host", "number", "checks"]),
      separators: true,
      gap: 6,
      wrap: false,
    });
  });

  it("removes the hostname before sacrificing the PR number or check word", () => {
    expect(present(127).visibleTextIds).toEqual(new Set(["number", "checks"]));
  });

  it("drops the complete check word next and retains its marker", () => {
    expect(present(100)).toEqual({
      visibleTextIds: new Set(["number"]),
      separators: false,
      gap: 4,
      wrap: false,
    });
    expect(present(60).visibleTextIds).toEqual(new Set());
  });

  it("never hides additional words when the available width grows", () => {
    let previous = present(44).visibleTextIds;
    for (let width = 45; width <= 250; width += 1) {
      const current = present(width).visibleTextIds;
      for (const id of previous) expect(current.has(id)).toBe(true);
      previous = current;
    }
  });

  it("uses translated measured widths rather than an English character estimate", () => {
    const translated: readonly MetaRowMeasuredItem[] = [
      MEASURED_ITEMS[0],
      MEASURED_ITEMS[1],
      { id: "ci", separator: true, fields: [{ id: "checks", priority: "checks", width: 80 }] },
    ];
    expect(present(127, translated).visibleTextIds).toEqual(new Set(["number"]));
  });

  it("keeps unmeasured text hidden without losing a known higher-priority field", () => {
    const pending: readonly MetaRowMeasuredItem[] = [
      { id: "host", separator: false, fields: [{ id: "host", priority: "host", width: null }] },
      MEASURED_ITEMS[1],
      MEASURED_ITEMS[2],
    ];
    expect(present(127, pending).visibleTextIds).toEqual(new Set(["number", "checks"]));
  });

  it("sacrifices plugin text before state and keeps all markers", () => {
    const withPlugin: readonly MetaRowMeasuredItem[] = [
      ...MEASURED_ITEMS,
      { id: "plugin", separator: false, fields: [{ id: "plugin", priority: "plugin", width: 40 }] },
    ];
    expect(present(140, withPlugin)).toEqual({
      visibleTextIds: new Set(["number", "checks"]),
      separators: false,
      gap: 4,
      wrap: false,
    });
  });

  it("wraps markers only after every word is gone and the icons themselves cannot fit", () => {
    expect(present(40)).toEqual({
      visibleTextIds: new Set(),
      separators: false,
      gap: 4,
      wrap: true,
    });
  });
});

describe("mixed metadata presentation", () => {
  it("preserves branch identity and the PR number after lower-priority names and state words", () => {
    const items: readonly MetaRowMeasuredItem[] = [
      { id: "branch", separator: false, fields: [{ id: "branch", priority: "branch", width: 50 }] },
      {
        id: "project",
        separator: true,
        fields: [{ id: "project", priority: "project", width: 35 }],
      },
      { ...MEASURED_ITEMS[0], separator: true },
      {
        id: "pr",
        separator: true,
        fields: [
          { id: "number", priority: "changeRequestNumber", width: 33 },
          { id: "state", priority: "changeRequestState", width: 40 },
        ],
      },
      MEASURED_ITEMS[2],
      {
        id: "service",
        separator: true,
        fields: [{ id: "service", priority: "services", width: 60 }],
      },
      { id: "labels", separator: true, fields: [{ id: "labels", priority: "labels", width: 65 }] },
    ];
    expect(present(200, items).visibleTextIds).toEqual(new Set(["branch", "number"]));
    expect(present(108, items).wrap).toBe(false);
    expect(present(107, items)).toEqual({
      visibleTextIds: new Set(),
      separators: false,
      gap: 4,
      wrap: true,
    });
  });

  it("keeps earlier plugin text when equally ranked plugin labels compete", () => {
    const items: readonly MetaRowMeasuredItem[] = [
      { id: "first", separator: false, fields: [{ id: "first", priority: "plugin", width: 30 }] },
      { id: "second", separator: false, fields: [{ id: "second", priority: "plugin", width: 30 }] },
    ];
    expect(present(58, items).visibleTextIds).toEqual(new Set(["first"]));
  });
});
