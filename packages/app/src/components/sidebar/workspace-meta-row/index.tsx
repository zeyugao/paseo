import { PressHighlight as Pressable } from "@/components/ui/press-highlight";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, Folder, GitBranch, Globe, Tags } from "lucide-react-native";
import {
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import type { HostBadgeModel } from "@/hosts/appearance";
import { HostBadge, HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import { WorkspaceLabelChip, WORKSPACE_LABEL_CHIP_INSET } from "@/workspace-labels/chip";
import type { PrHint } from "@/git/pr-hint";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { openExternalUrl } from "@/utils/open-external-url";
import { useSidebarMetaPreferences } from "@/components/sidebar/display-preferences/model";
import type { Theme } from "@/styles/theme";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import {
  PluginWorkspaceRowBadgeItems,
  usePluginWorkspaceRowBadgeItems,
} from "@/plugins/workspace-row-badge-items";
import { CheckIndicator } from "./check-indicator";
import type { CheckSummary, CheckSummaryState } from "./check-summary";
import { selectMetaRowItems, type MetaRowItem } from "./meta-items";
import {
  createMetaRowTextField,
  MetaRowLayout,
  MetaRowSlot,
  META_ITEM_GAP,
  type MetaRowField,
} from "./row-layout";
import type { MetaRowTextPriority } from "./presentation";
import { workspaceServiceLabelKey, type WorkspaceServiceSummary } from "./service-summary";

export {
  selectWorkspaceServiceSummary,
  workspaceServiceLabelKey,
  type WorkspaceServiceSummary,
} from "./service-summary";

const META_ICON_SIZE = HOST_BADGE_ICON_SIZE;
const EMPTY_LABELS: readonly WorkspaceLabelDefinition[] = [];
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedFolder = withUnistyles(Folder);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedGlobe = withUnistyles(Globe);
const ThemedTags = withUnistyles(Tags);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

export function WorkspaceMetaRow({
  currentBranch,
  projectName,
  hostBadge,
  prHint,
  serviceSummary,
  labels = EMPTY_LABELS,
  workspace = null,
}: {
  currentBranch: string | null;
  projectName: string | null;
  hostBadge: HostBadgeModel | null;
  prHint: PrHint | null;
  serviceSummary: WorkspaceServiceSummary | null;
  labels?: readonly WorkspaceLabelDefinition[];
  workspace?: { serverId: string; workspaceId: string } | null;
}) {
  const { rowItems, checksDisplay } = useSidebarMetaPreferences();
  const items = selectMetaRowItems({
    currentBranch,
    projectName,
    hasHostBadge: hostBadge !== null,
    prHint,
    serviceSummary,
    labels,
    visible: rowItems,
    checksDisplay,
  });
  const pluginItems = usePluginWorkspaceRowBadgeItems(workspace?.serverId ?? null);
  if (items.length === 0 && (!workspace || pluginItems.length === 0)) return null;
  return (
    <MetaRowLayout>
      {items.map((item, index) => (
        <MetaItemNode key={item.kind} item={item} hostBadge={hostBadge} leading={index === 0} />
      ))}
      {workspace ? (
        <PluginWorkspaceRowBadgeItems targets={pluginItems} workspaceId={workspace.workspaceId} />
      ) : null}
    </MetaRowLayout>
  );
}

function MetaItemNode({
  item,
  hostBadge,
  leading,
}: {
  item: MetaRowItem;
  hostBadge: HostBadgeModel | null;
  leading: boolean;
}): ReactNode {
  if (item.kind === "branch" || item.kind === "project") {
    return <IdentityItem kind={item.kind} name={item.name} leading={leading} />;
  }
  if (item.kind === "host") {
    return hostBadge ? <HostItem badge={hostBadge} leading={leading} /> : null;
  }
  if (item.kind === "changeRequest") {
    return <PullRequestItem hint={item.hint} leading={leading} />;
  }
  if (item.kind === "checks") {
    return <ChecksItem summary={item.summary} label={item.label} leading={leading} />;
  }
  if (item.kind === "labels") return <LabelsItem labels={item.labels} leading={leading} />;
  return <ServiceItem summary={item.summary} leading={leading} />;
}

function useTextFields({
  id,
  priority,
  text,
  enabled = true,
}: {
  id: string;
  priority: MetaRowTextPriority;
  text: string;
  enabled?: boolean;
}): readonly MetaRowField[] {
  return useMemo(
    () => (enabled ? [createMetaRowTextField({ id, priority, text })] : []),
    [id, priority, text, enabled],
  );
}

function HostItem({ badge, leading }: { badge: HostBadgeModel; leading: boolean }) {
  const iconBadge = useMemo(() => ({ ...badge, showLabel: false }), [badge]);
  const fields = useTextFields({
    id: "host",
    priority: "host",
    text: badge.label,
    enabled: badge.showLabel,
  });
  return (
    <MetaRowSlot id="host" fields={fields} separator={!leading} accessibilityLabel={badge.label}>
      {(visible) => <HostBadge badge={visible.has("host") ? badge : iconBadge} />}
    </MetaRowSlot>
  );
}

function IdentityItem({
  kind,
  name,
  leading,
}: {
  kind: "branch" | "project";
  name: string;
  leading: boolean;
}) {
  const Icon = kind === "branch" ? ThemedGitBranch : ThemedFolder;
  const fields = useTextFields({ id: kind, priority: kind, text: name });
  return (
    <MetaRowSlot id={kind} fields={fields} separator={!leading} accessibilityLabel={name}>
      {(visible) => (
        <View style={styles.item} testID={`sidebar-workspace-${kind}`}>
          <Icon size={META_ICON_SIZE} uniProps={mutedMapping} />
          {visible.has(kind) ? (
            <Text style={styles.text} numberOfLines={1}>
              {name}
            </Text>
          ) : null}
        </View>
      )}
    </MetaRowSlot>
  );
}

function LabelsItem({
  labels,
  leading,
}: {
  labels: readonly WorkspaceLabelDefinition[];
  leading: boolean;
}) {
  const fields = useMemo<readonly MetaRowField[]>(
    () => [
      {
        id: "labels",
        priority: "labels",
        widthAdjustment: -META_ICON_SIZE - (leading ? WORKSPACE_LABEL_CHIP_INSET : 0),
        measurement: <LabelChips labels={labels} leading={false} />,
      },
    ],
    [labels, leading],
  );
  const names = labels.map((label) => label.name).join(", ");
  return (
    <MetaRowSlot id="labels" fields={fields} separator={!leading} accessibilityLabel={names}>
      {(visible) =>
        visible.has("labels") ? (
          <LabelChips labels={labels} leading={leading} />
        ) : (
          <ThemedTags size={META_ICON_SIZE} uniProps={mutedMapping} />
        )
      }
    </MetaRowSlot>
  );
}

function LabelChips({
  labels,
  leading,
}: {
  labels: readonly WorkspaceLabelDefinition[];
  leading: boolean;
}) {
  return (
    <View style={[styles.labels, leading && styles.labelsLeading]}>
      {labels.map((label) => (
        <WorkspaceLabelChip key={workspaceLabelKey(label.name)} label={label} />
      ))}
    </View>
  );
}

function PullRequestItem({ hint, leading }: { hint: PrHint; leading: boolean }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const presentation = getForgePresentation(normalizeForge(hint.forge));
  const number = String(hint.number);
  const state = hint.state === "open" ? "" : t(PR_STATE_LABEL_KEYS[hint.state]);
  const fields = useMemo(() => {
    const numberField = createMetaRowTextField({
      id: "changeRequestNumber",
      priority: "changeRequestNumber",
      text: number,
    });
    if (!state) return [numberField];
    return [
      numberField,
      createMetaRowTextField({
        id: "changeRequestState",
        priority: "changeRequestState",
        text: state,
      }),
    ];
  }, [number, state]);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );
  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const requestLabel = t("workspace.git.pr.accessibility.pullRequest", {
    number: hint.number,
    context: presentation.changeRequestContext,
  });
  const accessibleLabel = state ? `${requestLabel}, ${state}` : requestLabel;
  const textStyle = isHovered ? styles.prTextHovered : styles.text;
  return (
    <MetaRowSlot
      id="changeRequest"
      fields={fields}
      separator={!leading}
      accessibilityLabel={accessibleLabel}
      accessible={false}
    >
      {(visible) => (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={accessibleLabel}
          hitSlop={4}
          onPressIn={handlePressIn}
          onPress={handlePress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          style={pressableItemStyle}
        >
          {isHovered ? (
            <ThemedExternalLink size={META_ICON_SIZE} uniProps={foregroundMapping} />
          ) : (
            <PullRequestStateIcon state={hint.state} size={META_ICON_SIZE} />
          )}
          {visible.has("changeRequestNumber") ? (
            <Text style={textStyle} numberOfLines={1}>
              {number}
            </Text>
          ) : null}
          {visible.has("changeRequestState") ? (
            <Text style={textStyle} numberOfLines={1}>
              {state}
            </Text>
          ) : null}
        </Pressable>
      )}
    </MetaRowSlot>
  );
}

function ChecksItem({
  summary,
  label,
  leading,
}: {
  summary: CheckSummary;
  label: boolean;
  leading: boolean;
}) {
  const { t } = useTranslation();
  const text = t(CHECK_STATE_LABEL_KEYS[summary.state]);
  const fields = useTextFields({ id: "checks", priority: "checks", text, enabled: label });
  return (
    <MetaRowSlot
      id="checks"
      fields={fields}
      separator={!leading}
      accessibilityLabel={t(CHECK_STATE_ACCESSIBLE_KEYS[summary.state])}
    >
      {(visible) => (
        <View style={styles.item} testID={`sidebar-workspace-checks-${summary.state}`}>
          <CheckIndicator summary={summary} size={META_ICON_SIZE} />
          {visible.has("checks") ? (
            <Text style={checksTextStyle(summary.state)} numberOfLines={1}>
              {text}
            </Text>
          ) : null}
        </View>
      )}
    </MetaRowSlot>
  );
}

function ServiceItem({ summary, leading }: { summary: WorkspaceServiceSummary; leading: boolean }) {
  const { t } = useTranslation();
  const unhealthy = summary.health === "unhealthy";
  const fields = useTextFields({ id: "services", priority: "services", text: summary.name });
  return (
    <MetaRowSlot
      id="services"
      fields={fields}
      separator={!leading}
      accessibilityLabel={t(workspaceServiceLabelKey(summary), { name: summary.name })}
    >
      {(visible) => (
        <View
          style={styles.item}
          testID={unhealthy ? "workspace-service-unhealthy" : "workspace-service"}
        >
          <ThemedGlobe
            size={META_ICON_SIZE}
            uniProps={unhealthy ? dangerMapping : successMapping}
          />
          {visible.has("services") ? (
            <Text style={unhealthy ? styles.textDanger : styles.textSuccess} numberOfLines={1}>
              {summary.name}
            </Text>
          ) : null}
        </View>
      )}
    </MetaRowSlot>
  );
}

const CHECK_STATE_LABEL_KEYS = {
  passed: "workspace.git.pr.checksSummary.passedLabel",
  failed: "workspace.git.pr.checksSummary.failedLabel",
  running: "workspace.git.pr.checksSummary.runningLabel",
} as const;
const CHECK_STATE_ACCESSIBLE_KEYS = {
  passed: "workspace.git.pr.checksSummary.passedAccessible",
  failed: "workspace.git.pr.checksSummary.failedAccessible",
  running: "workspace.git.pr.checksSummary.runningAccessible",
} as const;
const PR_STATE_LABEL_KEYS = {
  merged: "workspace.git.pr.states.merged",
  closed: "workspace.git.pr.states.closed",
} as const;

function pressableItemStyle({ pressed }: { pressed: boolean }) {
  return [styles.item, pressed && styles.itemPressed];
}

const styles = StyleSheet.create((theme) => ({
  item: { flexDirection: "row", alignItems: "center", gap: META_ITEM_GAP, flexShrink: 0 },
  itemPressed: { opacity: 0.82 },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  prTextHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  labels: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 0 },
  labelsLeading: { marginLeft: -WORKSPACE_LABEL_CHIP_INSET },
  textSuccess: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  textDanger: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  textWarning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
}));

function checksTextStyle(state: CheckSummaryState) {
  if (state === "passed") return styles.textSuccess;
  if (state === "failed") return styles.textDanger;
  return styles.textWarning;
}
