import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { Text, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  selectMetaRowPresentation,
  type MetaRowMeasuredItem,
  type MetaRowPresentation,
  type MetaRowTextPriority,
} from "./presentation";

export const META_ITEM_GAP = 3;

export interface MetaRowField {
  id: string;
  priority: MetaRowTextPriority;
  measurement: ReactNode;
  widthAdjustment: number;
}

interface SlotRegistration {
  id: string;
  separator: boolean;
  fields: readonly MetaRowField[];
}

interface LayoutState {
  width: number;
  separatorWidth: number | null;
  slots: ReadonlyMap<string, SlotRegistration>;
  measurements: ReadonlyMap<MetaRowField, number>;
}

type LayoutAction =
  | { type: "width"; width: number }
  | { type: "separator"; width: number }
  | { type: "register"; slot: SlotRegistration }
  | { type: "unregister"; id: string }
  | { type: "measure"; field: MetaRowField; width: number };

interface MeasurementContextValue {
  register: (slot: SlotRegistration) => void;
  unregister: (id: string) => void;
  measure: (field: MetaRowField, width: number) => void;
}

const MeasurementContext = createContext<MeasurementContextValue | null>(null);
const PresentationContext = createContext<MetaRowPresentation | null>(null);

function initialLayoutState(): LayoutState {
  return { width: 0, separatorWidth: null, slots: new Map(), measurements: new Map() };
}

function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  if (action.type === "width") {
    if (action.width <= 0 || action.width === state.width) return state;
    return { ...state, width: action.width };
  }
  if (action.type === "separator") {
    if (action.width === state.separatorWidth) return state;
    return { ...state, separatorWidth: action.width };
  }
  if (action.type === "measure") {
    const isCurrentField = Array.from(state.slots.values()).some((slot) =>
      slot.fields.includes(action.field),
    );
    if (!isCurrentField || state.measurements.get(action.field) === action.width) return state;
    const measurements = new Map(state.measurements);
    measurements.set(action.field, action.width);
    return { ...state, measurements };
  }
  const id = action.type === "register" ? action.slot.id : action.id;
  const currentSlot = state.slots.get(id);
  if (action.type === "register" && currentSlot === action.slot) return state;
  if (action.type === "unregister" && !currentSlot) return state;
  const slots = new Map(state.slots);
  const measurements = new Map(state.measurements);
  if (currentSlot) {
    for (const field of currentSlot.fields) measurements.delete(field);
  }
  if (action.type === "register") slots.set(action.slot.id, action.slot);
  else slots.delete(action.id);
  return { ...state, slots, measurements };
}

export function createMetaRowTextField({
  id,
  priority,
  text,
  widthAdjustment = META_ITEM_GAP,
}: {
  id: string;
  priority: MetaRowTextPriority;
  text: string;
  widthAdjustment?: number;
}): MetaRowField {
  return {
    id,
    priority,
    widthAdjustment,
    measurement: (
      <Text style={styles.measureText} numberOfLines={1}>
        {text}
      </Text>
    ),
  };
}

export function MetaRowLayout({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(layoutReducer, undefined, initialLayoutState);
  const register = useCallback((slot: SlotRegistration) => {
    dispatch({ type: "register", slot });
  }, []);
  const unregister = useCallback((id: string) => {
    dispatch({ type: "unregister", id });
  }, []);
  const measure = useCallback((field: MetaRowField, width: number) => {
    if (width <= 0) return;
    dispatch({ type: "measure", field, width: Math.ceil(width) });
  }, []);
  const measureWidth = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (height <= 0) return;
    dispatch({ type: "width", width });
  }, []);
  const measureSeparator = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    dispatch({ type: "separator", width: Math.ceil(width) });
  }, []);
  const measurements = useMemo(
    () => ({ register, unregister, measure }),
    [register, unregister, measure],
  );
  const presentation = useMemo(() => {
    const items: MetaRowMeasuredItem[] = [];
    for (const slot of state.slots.values()) {
      items.push({
        id: slot.id,
        separator: slot.separator,
        fields: slot.fields.map((field) => {
          const measuredWidth = state.measurements.get(field);
          const width =
            measuredWidth === undefined ? null : Math.max(0, measuredWidth + field.widthAdjustment);
          return { id: field.id, priority: field.priority, width };
        }),
      });
    }
    return selectMetaRowPresentation({
      availableWidth: state.width,
      items,
      markerWidth: HOST_BADGE_ICON_SIZE,
      separatorWidth: state.separatorWidth,
      gap: 6,
      compactGap: 4,
    });
  }, [state]);
  const rowGeometry: ViewStyle = {
    gap: presentation.gap,
    flexWrap: presentation.wrap ? "wrap" : "nowrap",
  };

  return (
    <MeasurementContext.Provider value={measurements}>
      <PresentationContext.Provider value={presentation}>
        <View
          style={[
            styles.row,
            state.slots.size === 0 && styles.empty,
            inlineUnistylesStyle(rowGeometry),
          ]}
          onLayout={measureWidth}
          testID="sidebar-workspace-meta-row"
        >
          {children}
          <Text
            style={[styles.measureText, styles.measurement]}
            onLayout={measureSeparator}
            accessible={false}
            importantForAccessibility="no"
          >
            ·
          </Text>
        </View>
      </PresentationContext.Provider>
    </MeasurementContext.Provider>
  );
}

interface MetaRowSlotProps extends SlotRegistration {
  accessibilityLabel: string;
  accessible?: boolean;
  children: (visibleTextIds: ReadonlySet<string>) => ReactNode;
}

export function MetaRowSlot({
  id,
  separator,
  fields,
  accessibilityLabel,
  accessible = true,
  children,
}: MetaRowSlotProps) {
  const measurements = useContext(MeasurementContext);
  const presentation = useContext(PresentationContext);
  const registration = useMemo(() => ({ id, separator, fields }), [id, separator, fields]);
  useLayoutEffect(() => {
    if (measurements === null) return;
    measurements.register(registration);
  }, [measurements, registration]);
  useLayoutEffect(() => {
    if (measurements === null) return;
    return () => measurements.unregister(id);
  }, [measurements, id]);

  // The SDK badge also renders outside a workspace row; there it keeps its authored text.
  const visibleTextIds = useMemo(() => {
    if (presentation) return presentation.visibleTextIds;
    return new Set(fields.map((field) => field.id));
  }, [presentation, fields]);
  const hiddenText = fields.some((field) => !visibleTextIds.has(field.id));
  const gap = presentation?.gap ?? 6;
  const showSeparator = separator && presentation?.separators;
  return (
    <View style={[styles.slot, inlineUnistylesStyle({ gap })]}>
      {showSeparator ? <Text style={styles.separator}>·</Text> : null}
      <Tooltip enabledOnDesktop={hiddenText || fields.length === 0}>
        <TooltipTrigger asChild>
          <View style={styles.body} accessible={accessible} accessibilityLabel={accessibilityLabel}>
            {children(visibleTextIds)}
          </View>
        </TooltipTrigger>
        <TooltipContent>
          <Text>{accessibilityLabel}</Text>
        </TooltipContent>
      </Tooltip>
      {measurements
        ? fields.map((field) => (
            <FieldMeasurement key={field.id} field={field} measure={measurements.measure} />
          ))
        : null}
    </View>
  );
}

function FieldMeasurement({
  field,
  measure,
}: {
  field: MetaRowField;
  measure: MeasurementContextValue["measure"];
}) {
  const reference = useRef<View>(null);
  // A new field can have the same size as its predecessor, so onLayout alone need not fire.
  useLayoutEffect(() => {
    reference.current?.measure((_x, _y, width, height) => {
      if (height > 0) measure(field, width);
    });
  }, [field, measure]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (height > 0) measure(field, width);
    },
    [field, measure],
  );
  return (
    <View
      ref={reference}
      style={styles.measurement}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {field.measurement}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  empty: { minHeight: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    minWidth: 0,
    minHeight: 16 * rt.fontScale,
  },
  slot: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  body: { minWidth: HOST_BADGE_ICON_SIZE, flexShrink: 0 },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  measureText: { fontSize: theme.fontSize.sm, lineHeight: 16, flexShrink: 0 },
  // A row-axis absolute measurement has no width constraint and never changes its peers'
  // allocation. Visibility therefore cannot feed back into the measured natural width.
  measurement: { position: "absolute", left: 0, flexDirection: "row", opacity: 0 },
}));
