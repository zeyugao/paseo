import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { BottomSheetScrollView, type BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { Wrench, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  type ContextBridge,
  SheetVisibleFrame,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { ToolCallSheetModal, useToolCallSheetContextBridge } from "@/components/tool-call-sheet";
import { useToolCallExpansionContextBridge } from "@/tool-calls/expansion-context";
import type { Theme } from "@/styles/theme";

interface OverviewToolCallGroupSheetProps {
  visible: boolean;
  summary: string;
  callCount: number;
  children: ReactNode;
  onClose: () => void;
}

const SNAP_POINTS = ["60%", "95%"];
const ThemedWrench = withUnistyles(Wrench);
const ThemedX = withUnistyles(X);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function OverviewToolCallGroupSheet({
  visible,
  summary,
  callCount,
  children,
  onClose,
}: OverviewToolCallGroupSheetProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const isFollowingRef = useRef(true);
  const scrollOffsetRef = useRef(0);
  const contentCallCountRef = useRef(0);
  const sheetContextBridge = useToolCallSheetContextBridge();
  const expansionContextBridge = useToolCallExpansionContextBridge();
  const contextBridge = useCallback<ContextBridge>(
    (content) => sheetContextBridge(expansionContextBridge(content)),
    [expansionContextBridge, sheetContextBridge],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });

  const scrollToLatest = useCallback(() => {
    if (visible && isFollowingRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [visible]);
  const handleContentSizeChange = useCallback(() => {
    // A new call can lay out after the effect's frame; detail-only resizing must not jump.
    if (contentCallCountRef.current === callCount) return;
    contentCallCountRef.current = callCount;
    scrollToLatest();
  }, [callCount, scrollToLatest]);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (layoutMeasurement.height <= 0) return;
    const isAtEnd = contentSize.height - layoutMeasurement.height - contentOffset.y <= 1;
    // Growth can report the old offset before the pending end scroll lands.
    if (isAtEnd || contentOffset.y < scrollOffsetRef.current) {
      isFollowingRef.current = isAtEnd;
    }
    scrollOffsetRef.current = contentOffset.y;
  }, []);
  useEffect(() => {
    if (!visible) {
      isFollowingRef.current = true;
      scrollOffsetRef.current = 0;
      contentCallCountRef.current = 0;
      return;
    }
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [callCount, scrollToLatest, visible]);

  return (
    <ToolCallSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      enableContentPanningGesture={false}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      backdropOpacity={0.5}
      enablePanDownToClose
    >
      <SheetVisibleFrame>
        <View style={styles.container} testID="tool-call-group-sheet">
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <ThemedWrench size={20} uniProps={foregroundMapping} />
              <Text
                style={styles.headerTitle}
                numberOfLines={2}
                testID="tool-call-group-sheet-summary"
              >
                {summary}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel={t("common.actions.close")}
              testID="tool-call-group-sheet-close"
            >
              <ThemedX size={20} uniProps={foregroundMutedMapping} />
            </Pressable>
          </View>
          <BottomSheetScrollView
            ref={scrollRef}
            style={styles.content}
            testID="tool-call-group-sheet-scroll"
            onLayout={scrollToLatest}
            onContentSizeChange={handleContentSizeChange}
            onScroll={handleScroll}
          >
            <View style={styles.contentContainer}>{children}</View>
          </BottomSheetScrollView>
        </View>
      </SheetVisibleFrame>
    </ToolCallSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flex: 1,
  },
  closeButton: {
    padding: theme.spacing[2],
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface2,
  },
  contentContainer: {
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
}));
