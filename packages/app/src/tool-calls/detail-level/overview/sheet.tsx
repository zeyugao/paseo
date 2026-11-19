import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { BottomSheetScrollView, type BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { Wrench } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  type ContextBridge,
  SheetVisibleFrame,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { SheetHeaderView, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ToolCallSheetModal, useToolCallSheetContextBridge } from "@/components/tool-call-sheet";
import { useToolCallExpansionContextBridge } from "@/tool-calls/expansion-context";
import { ICON_SIZE, type Theme } from "@/styles/theme";

interface OverviewToolCallGroupSheetProps {
  visible: boolean;
  summary: string;
  callCount: number;
  children: ReactNode;
  onClose: () => void;
}

const SNAP_POINTS = ["60%", "95%"];
const ThemedWrench = withUnistyles(Wrench);
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const headerIcon = <ThemedWrench size={ICON_SIZE.md} uniProps={foregroundMapping} />;

export function OverviewToolCallGroupSheet({
  visible,
  summary,
  callCount,
  children,
  onClose,
}: OverviewToolCallGroupSheetProps) {
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
  const header = useMemo<SheetHeader>(
    () => ({ title: summary, titleTestID: "tool-call-group-sheet-summary", leading: headerIcon }),
    [summary],
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
          <SheetHeaderView
            header={header}
            onClose={onClose}
            closeTestID="tool-call-group-sheet-close"
          />
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
