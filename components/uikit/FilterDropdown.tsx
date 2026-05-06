import { useTheme } from "@/lib/ThemeContext";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DimensionValue, StyleProp, ViewStyle } from "react-native";
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

/* ── Item types ─────────────────────────────────────────────── */

export type SelectOption = {
  value: string;
  label: string;
  icon?: React.ReactNode | ((color: string) => React.ReactNode);
  indicatorShape?: "circle" | "square";
  /** Справа вместо кружка (например стрелка отправитель/получатель). */
  trailingIcon?: React.ReactNode | ((color: string) => React.ReactNode);
};

export type SelectAction = {
  type: "action";
  label: string;
  icon?: React.ReactNode | ((color: string) => React.ReactNode);
  onPress: () => void;
};

export type SelectGroupLabel = {
  type: "group";
  label: string;
  /** If set, rendered instead of the uppercase `label` text (keep `label` for width / fallback). */
  labelNode?: React.ReactNode;
  subtitle?: string | React.ReactNode;
};

export type SelectSubmenu = {
  type: "submenu";
  label: string;
  /** Shown in the back row when inside this submenu (e.g. "Назад") instead of label. */
  backLabel?: string;
  icon?: React.ReactNode | ((color: string) => React.ReactNode);
  children: SelectItem[];
};

export type SelectCustom = {
  type: "custom";
  label: string;
  backLabel?: string;
  /** Preferred dropdown content height for this custom view. */
  preferredHeight?: number;
  /** Receives onClose and openSubmenu (push a list submenu, returns selected value or null). */
  content: (props: {
    onClose: () => void;
    openSubmenu: (
      title: string,
      items: { value: string; label: string }[]
    ) => Promise<string | null>;
  }) => React.ReactNode;
};

export type SelectItem =
  | SelectOption
  | SelectAction
  | SelectGroupLabel
  | SelectSubmenu
  | SelectCustom;

/* ── Props ──────────────────────────────────────────────────── */

export type FilterDropdownProps = {
  value?: string;
  /** When set, options matching this value also show as selected (e.g. sort when value is date filter). */
  secondaryValue?: string;
  onChange?: (value: string) => void;
  options: SelectItem[];
  /** Подпись над триггером */
  label?: string;
  placeholder?: string;
  resetLabel?: string;
  onReset?: () => void;
  disabled?: boolean;
  variant?: "secondary" | "outline" | "ghost" | "chip";
  width?: DimensionValue;
  minWidth?: DimensionValue;
  maxWidth?: DimensionValue;
  maxDropdownHeight?: number;
  keepOpen?: boolean;
  /** Скрыть колонку «радио» у опций (списки только для просмотра). */
  hideRadio?: boolean;
  trigger?: (props: { open: boolean; onPress: () => void }) => React.ReactNode;
  /** Описание под триггером (мелкий текст) */
  description?: string;
  style?: StyleProp<ViewStyle>;
};

/* ── Constants ──────────────────────────────────────────────── */

const DROPDOWN_PAD = 6;
const ITEM_HEIGHT = 44;
const GROUP_HEIGHT = 30;
const BACK_ROW_HEIGHT = 40;
/** Calendar dropdown: content-sized height (back row + pad + wrap + header + weekdays + 6 rows + summary + actions), not full screen, not smaller than content */
const CALENDAR_CONTENT_H =
  BACK_ROW_HEIGHT +
  DROPDOWN_PAD * 2 +
  24 /* wrap pad */ +
  52 /* header */ +
  26 /* weekdays */ +
  6 * (38 + 4) /* 6 rows (cell + gap) */ +
  36 /* summary */ +
  52 /* actions */;
const RADIO_SIZE = 18;
const RADIO_DOT = 8;
const SCREEN_MARGIN = 12;
const ANIM_MS = 180;

function findLabelByValue(items: SelectItem[], value: string | undefined): string | undefined {
  if (!value) return undefined;
  for (const item of items) {
    if (!("type" in item) && item.value === value) return item.label;
    if ("type" in item && item.type === "submenu") {
      const found = findLabelByValue(item.children, value);
      if (found) return found;
    }
  }
  return undefined;
}

/* ── Component ──────────────────────────────────────────────── */

export function FilterDropdown({
  value,
  secondaryValue,
  onChange,
  options,
  label: selectLabel,
  placeholder = "Select…",
  resetLabel,
  onReset,
  disabled = false,
  variant = "outline",
  width,
  minWidth = 140,
  maxWidth,
  maxDropdownHeight = 300,
  keepOpen = false,
  hideRadio = false,
  trigger: customTrigger,
  description,
  style,
}: FilterDropdownProps) {
  const { colors } = useTheme();
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState({ x: 0, y: 0, w: 200, h: 40 });
  const [positionLock, setPositionLock] = useState<{
    top: number;
    left: number;
    opensBelow: boolean;
    width: number;
  } | null>(null);

  /* ── Submenu stack ── */
  type PickerLevel = {
    type: "picker";
    title: string;
    items: SelectOption[];
    resolve: (value: string | null) => void;
  };
  type MenuLevel =
    | { type: "list"; items: SelectItem[]; label: string; backLabel?: string }
    | {
        type: "custom";
        contentFn: (props: {
          onClose: () => void;
          openSubmenu: (
            title: string,
            items: { value: string; label: string }[]
          ) => Promise<string | null>;
        }) => React.ReactNode;
        label: string;
        preferredHeight?: number;
      }
    | PickerLevel;
  const [menuStack, setMenuStack] = useState<MenuLevel[]>([]);
  const contentFadeAnim = useRef(new Animated.Value(1)).current;
  const isContentTransitioningRef = useRef(false);
  const menuHeightAnim = useRef(new Animated.Value(0)).current;

  const runContentTransition = useCallback((change: () => void) => {
    if (isContentTransitioningRef.current) {
      change();
      return;
    }
    isContentTransitioningRef.current = true;
    Animated.timing(contentFadeAnim, {
      toValue: 0,
      duration: 90,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      change();
      requestAnimationFrame(() => {
        Animated.timing(contentFadeAnim, {
          toValue: 1,
          duration: 130,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start(() => {
          isContentTransitioningRef.current = false;
        });
      });
    });
  }, [contentFadeAnim]);

  const topLevel = menuStack.length > 0 ? menuStack[menuStack.length - 1] : null;
  const currentItems =
    topLevel?.type === "list"
      ? topLevel.items
      : topLevel?.type === "picker"
        ? topLevel.items
        : options;
  const currentLabel =
    topLevel?.type === "picker"
      ? topLevel.title
      : topLevel?.type === "list" && "backLabel" in topLevel && topLevel.backLabel != null
        ? topLevel.backLabel
        : (topLevel?.label ?? "");
  const showingCustomContent = topLevel?.type === "custom";
  const showingPicker = topLevel?.type === "picker";
  const customLevelUnderPicker =
    showingPicker && menuStack.length >= 2 && menuStack[menuStack.length - 2].type === "custom"
      ? (menuStack[menuStack.length - 2] as Extract<MenuLevel, { type: "custom" }>)
      : null;
  /** Single custom level instance: when showing custom use topLevel, when showing picker use level below so same instance stays mounted */
  const activeCustomLevel =
    topLevel?.type === "custom" ? topLevel : customLevelUnderPicker;

  const pushSubmenu = (sub: SelectSubmenu) => {
    const children = sub.children;
    const only =
      children.length === 1 && "type" in children[0] && children[0].type === "custom"
        ? (children[0] as SelectCustom)
        : null;
    const level: MenuLevel = only
      ? {
          type: "custom",
          label: only.backLabel ?? sub.label,
          preferredHeight: only.preferredHeight,
          contentFn: only.content,
        }
      : {
          type: "list",
          items: sub.children,
          label: sub.label,
          ...(sub.backLabel != null ? { backLabel: sub.backLabel } : {}),
        };
    runContentTransition(() => setMenuStack((s) => [...s, level]));
  };

  const popSubmenu = () => {
    runContentTransition(() => setMenuStack((s) => s.slice(0, -1)));
  };

  const openSubmenu = useCallback(
    (title: string, items: { value: string; label: string }[]) => {
      return new Promise<string | null>((resolve) => {
        const options: SelectOption[] = items.map(({ value, label }) => ({
          value,
          label,
        }));
        const level: PickerLevel = { type: "picker", title, items: options, resolve };
        runContentTransition(() => setMenuStack((s) => [...s, level]));
      });
    },
    [runContentTransition]
  );

  const handleBackPress = () => {
    if (topLevel?.type === "picker") {
      topLevel.resolve(null);
    }
    popSubmenu();
  };

  const handleItemSelect = (val: string) => {
    if (topLevel?.type === "picker") {
      topLevel.resolve(val);
      popSubmenu();
      return;
    }
    handleSelect(val);
  };

  const selectedOption = options.find(
    (o): o is SelectOption => !("type" in o) && o.value === value
  );
  const displayLabel =
    selectedOption?.label ?? findLabelByValue(options, value) ?? placeholder;
  const isPlaceholder = !selectedOption;

  const measure = useCallback(() => {
    if (!triggerRef.current) return;
    if (Platform.OS === "web") {
      const el = triggerRef.current as unknown as HTMLElement;
      if (el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        setLayout({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    } else {
      triggerRef.current.measureInWindow((x, y, w, h) => {
        if (w > 0 && h > 0) setLayout({ x, y, w, h });
      });
    }
  }, []);

  const handleOpen = () => {
    if (disabled) return;
    measure();
    setMenuStack([]);
    contentFadeAnim.setValue(1);
    isContentTransitioningRef.current = false;
    setPositionLock(null);
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setMenuStack([]);
    setPositionLock(null);
    contentFadeAnim.setValue(1);
    isContentTransitioningRef.current = false;
  };

  const handleSelect = (val: string) => {
    onChange?.(val);
    if (!keepOpen) handleClose();
  };

  const handleAction = (action: SelectAction) => {
    action.onPress();
    handleClose();
  };

  const handleReset = () => {
    onReset?.();
    handleClose();
  };

  /* ── Trigger style by variant ── */

  const borderColor =
    variant === "outline"
      ? colors.accent
      : variant === "chip"
        ? colors.accent + "55"
        : variant === "secondary"
          ? colors.accent + "35"
          : "transparent";

  const bg =
    variant === "secondary"
      ? colors.accent + "28"
      : variant === "chip"
        ? colors.accent + "22"
        : "transparent";

  const borderW =
    variant === "outline"
      ? 2
      : variant === "chip" || variant === "secondary"
        ? 1
        : 0;

  /* ── Dropdown position ── */

  const screen = Dimensions.get("window");

  const allLabels = collectAllLabels(options);
  const longestLabel = allLabels.reduce(
    (max, l) => Math.max(max, l.length),
    0
  );
  const estimatedTextW =
    longestLabel * 9 + 14 * 2 + 28 + (hideRadio ? 8 : RADIO_SIZE) + 20;
  const minW = showingCustomContent ? 280 : 180;
  const dropWRaw = Math.min(
    Math.max(layout.w, estimatedTextW, minW),
    screen.width - SCREEN_MARGIN * 2
  );

  const optionCount = showingCustomContent
    ? 4
    : currentItems.filter(
        (o) => !("type" in o) || (o as any).type !== "group"
      ).length;
  const groupCount = showingCustomContent
    ? 0
    : currentItems.filter(
        (o) => "type" in o && (o as any).type === "group"
      ).length;
  const groupSubtitleExtra = showingCustomContent
    ? 0
    : currentItems.reduce((acc, o) => {
        if ("type" in o && o.type === "group") {
          const g = o as SelectGroupLabel;
          let add = 0;
          if (g.labelNode != null) add += 36;
          const st = g.subtitle;
          if (typeof st === "string" && st.trim()) add += 44;
          if (st != null && typeof st !== "string") add += 56;
          return acc + add;
        }
        return acc;
      }, 0);
  const estimatedH =
    optionCount * ITEM_HEIGHT +
    groupCount * GROUP_HEIGHT +
    groupSubtitleExtra +
    DROPDOWN_PAD * 2 +
    (menuStack.length > 0 ? BACK_ROW_HEIGHT : 0) +
    (resetLabel && menuStack.length === 0 ? 28 : 0);

  const spaceBelow = screen.height - layout.y - layout.h - SCREEN_MARGIN;
  const spaceAbove = layout.y - SCREEN_MARGIN;
  const opensBelowRaw =
    spaceBelow >= Math.min(estimatedH, maxDropdownHeight) ||
    spaceBelow >= spaceAbove;

  const GAP = 4;
  let dropTop: number;
  if (opensBelowRaw) {
    dropTop = layout.y + layout.h + GAP;
  } else {
    const dropHPreview = Math.min(
      estimatedH,
      Math.min(maxDropdownHeight, Math.max(spaceAbove, 100))
    );
    dropTop = layout.y - dropHPreview - GAP;
    if (dropTop < SCREEN_MARGIN) dropTop = SCREEN_MARGIN;
  }

  const customPreferredH = activeCustomLevel?.preferredHeight;
  const marginBottom = showingCustomContent ? 8 : SCREEN_MARGIN;
  const customMaxH = customPreferredH ?? maxDropdownHeight;
  const clampedMaxH = Math.min(
    showingCustomContent ? customMaxH : maxDropdownHeight,
    opensBelowRaw ? Math.max(spaceBelow, 100) : Math.max(spaceAbove, 100)
  );
  const dropH = showingCustomContent
    ? customPreferredH != null
      ? Math.min(customPreferredH, clampedMaxH)
      : clampedMaxH
    : Math.min(estimatedH, clampedMaxH);

  useEffect(() => {
    if (!open) {
      menuHeightAnim.setValue(dropH);
      return;
    }
    Animated.timing(menuHeightAnim, {
      toValue: dropH,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [open, dropH, menuHeightAnim]);

  const listChromeH =
    (menuStack.length > 0 ? BACK_ROW_HEIGHT : 0) +
    (resetLabel && menuStack.length === 0 ? 28 : 0) +
    DROPDOWN_PAD * 2;
  const listScrollMaxH = Math.max(80, dropH - listChromeH);
  /** Lock height only for explicitly fixed custom views (e.g. compact pages editor). */
  const lockMenuHeightLayout = customPreferredH != null;

  let dropLeftRaw = layout.x;
  if (dropLeftRaw + dropWRaw > screen.width - SCREEN_MARGIN) {
    dropLeftRaw = screen.width - dropWRaw - SCREEN_MARGIN;
  }
  if (dropLeftRaw < SCREEN_MARGIN) dropLeftRaw = SCREEN_MARGIN;

  useEffect(() => {
    if (!open || positionLock) return;
    setPositionLock({
      top: dropTop,
      left: dropLeftRaw,
      opensBelow: opensBelowRaw,
      width: dropWRaw,
    });
  }, [open, positionLock, dropTop, dropLeftRaw, opensBelowRaw, dropWRaw]);

  const opensBelow = positionLock?.opensBelow ?? opensBelowRaw;
  const dropLeft = positionLock?.left ?? dropLeftRaw;
  const lockedTop = positionLock?.top ?? dropTop;
  const dropW = positionLock?.width ?? dropWRaw;

  /* ── Render items ── */

  const renderItem = (item: SelectItem, idx: number) => {
    if ("type" in item && item.type === "group") {
      const rawSub = item.subtitle;
      const strSub = typeof rawSub === "string" ? rawSub.trim() : "";
      const hasStr = strSub.length > 0;
      const hasNode = rawSub != null && typeof rawSub !== "string";
      const header =
        item.labelNode != null ? (
          <View style={s.groupHeaderRow}>{item.labelNode}</View>
        ) : (
          <Text selectable={false} style={[s.groupLabel, { color: colors.sub }]}>
            {item.label}
          </Text>
        );
      return (
        <View key={`g-${idx}`} style={s.groupRow}>
          {header}
          {hasStr ? (
            <Text
              selectable={false}
              numberOfLines={4}
              style={[s.groupSubtitle, { color: colors.sub }]}
            >
              {strSub}
            </Text>
          ) : hasNode ? (
            <View style={s.groupSubtitleWrap}>{rawSub as React.ReactNode}</View>
          ) : null}
        </View>
      );
    }

    if ("type" in item && item.type === "submenu") {
      const sub = item;
      const icon =
        typeof sub.icon === "function" ? sub.icon(colors.txt) : sub.icon;
      return (
        <Pressable
          key={`sub-${idx}`}
          onPress={() => pushSubmenu(sub)}
          style={({ hovered }: { hovered?: boolean }) => [
            s.option,
            hovered && { backgroundColor: colors.accent + "12" },
          ]}
        >
          {icon && <View style={s.optionIcon}>{icon}</View>}
          <Text
            selectable={false}
            numberOfLines={1}
            style={[s.optionText, { color: colors.txt }]}
          >
            {sub.label}
          </Text>
          <Feather name="chevron-right" size={16} color={colors.sub} />
        </Pressable>
      );
    }

    if ("type" in item && item.type === "action") {
      const act = item;
      const icon =
        typeof act.icon === "function" ? act.icon(colors.txt) : act.icon;
      return (
        <Pressable
          key={`a-${idx}`}
          onPress={() => handleAction(act)}
          style={({ hovered }: { hovered?: boolean }) => [
            s.option,
            hovered && { backgroundColor: colors.accent + "12" },
          ]}
        >
          {icon && <View style={s.optionIcon}>{icon}</View>}
          <Text
            selectable={false}
            numberOfLines={1}
            style={[s.optionText, { color: colors.txt }]}
          >
            {act.label}
          </Text>
        </Pressable>
      );
    }

    const opt = item as SelectOption;
    const isSel =
      opt.value === value ||
      (secondaryValue != null && opt.value === secondaryValue);
    const icon =
      typeof opt.icon === "function"
        ? opt.icon(isSel ? colors.accent : colors.txt)
        : opt.icon;
    const trailingIcon =
      opt.trailingIcon != null
        ? typeof opt.trailingIcon === "function"
          ? opt.trailingIcon(colors.accent)
          : opt.trailingIcon
        : null;
    const indicatorShape = opt.indicatorShape ?? "circle";

    return (
      <Pressable
        key={opt.value}
        onPress={() => handleItemSelect(opt.value)}
        style={({ hovered }: { hovered?: boolean }) => [
          s.option,
          isSel && { backgroundColor: colors.accent + "14" },
          hovered && !isSel && { backgroundColor: colors.accent + "0c" },
        ]}
      >
        {icon && <View style={s.optionIcon}>{icon}</View>}
        <Text
          numberOfLines={1}
          style={[
            s.optionText,
            { color: isSel ? colors.accent : colors.txt },
            isSel && s.optionTextBold,
          ]}
        >
          {opt.label}
        </Text>
        {trailingIcon ? (
          <View style={s.optionIcon}>{trailingIcon}</View>
        ) : hideRadio ? null : (
          <View
            style={[
              s.radio,
              indicatorShape === "square" ? s.radioSquare : null,
              { borderColor: isSel ? colors.accent : colors.sub + "60" },
            ]}
          >
            {isSel && (
              <View
                style={[
                  s.radioDot,
                  indicatorShape === "square" ? s.radioDotSquare : null,
                  { backgroundColor: colors.accent },
                ]}
              />
            )}
          </View>
        )}
      </Pressable>
    );
  };

  const canReset = onReset != null && resetLabel != null;

  return (
    <View style={s.selectWrap}>
      {(selectLabel != null && selectLabel !== "") || canReset ? (
        <View style={s.labelRow}>
          {selectLabel != null && selectLabel !== "" ? (
            <Text selectable={false} style={[s.selectLabel, { color: colors.txt }]} numberOfLines={1}>
              {selectLabel}
            </Text>
          ) : (
            <View style={s.labelSpacer} />
          )}
          {canReset ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                onReset?.();
              }}
              hitSlop={8}
              style={({ hovered }: { hovered?: boolean }) => [s.resetBtn, hovered && { opacity: 0.85 }]}
            >
              <Text selectable={false} style={[s.resetBtnText, { color: colors.accent }]}>
                {resetLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* ── Trigger ── */}
      {customTrigger ? (
        <View ref={triggerRef} collapsable={false} style={style}>
          {customTrigger({ open, onPress: handleOpen })}
        </View>
      ) : (
        <Pressable
          ref={triggerRef as any}
          onPress={handleOpen}
          disabled={disabled}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            s.trigger,
            s.triggerPress,
            {
              borderColor: open ? colors.accent : borderColor,
              backgroundColor: bg,
              borderWidth: borderW,
            },
            hovered && !disabled && !open && {
              backgroundColor: colors.accent + "12",
              borderColor: colors.accent + "55",
            },
            pressed && { opacity: 0.9 },
            width != null && { width },
            minWidth != null && { minWidth },
            maxWidth != null && { maxWidth },
            style,
            Platform.OS === "web" && ({ userSelect: "none" } as any),
          ]}
        >
          <Text
            selectable={false}
            numberOfLines={1}
            style={[
              s.triggerText,
              { color: isPlaceholder ? colors.sub : colors.accent },
            ]}
          >
            {displayLabel}
          </Text>
          <Feather
            name={open ? "chevron-up" : "chevron-down"}
            size={16}
            color={colors.accent}
          />
        </Pressable>
      )}

      {description != null && description !== "" ? (
        <Text selectable={false} style={[s.description, { color: colors.sub }]} numberOfLines={3}>
          {description}
        </Text>
      ) : null}

      {/* ── Dropdown ── */}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable style={s.backdrop} onPress={handleClose} />

        <Animated.View
          pointerEvents="box-none"
          style={[
            s.menu,
            {
              top: lockedTop,
              left: dropLeft,
              width: dropW,
              maxHeight: menuHeightAnim,
              ...(lockMenuHeightLayout ? { height: menuHeightAnim } : {}),
              backgroundColor: colors.surfaceElevated,
              borderColor: colors.accent + "20",
            },
            Platform.OS === "web" && ({ userSelect: "none" } as any),
          ]}
        >
          {/* Back row for submenu */}
          {menuStack.length > 0 && (
            <Pressable
              onPress={handleBackPress}
              style={({ hovered }: { hovered?: boolean }) => [
                s.backRow,
                { borderBottomColor: colors.sub + "20" },
                hovered && { backgroundColor: colors.accent + "0c" },
              ]}
            >
              <Feather
                name="arrow-left"
                size={16}
                color={colors.accent}
                style={{ marginRight: 8 }}
              />
              <Text selectable={false} style={[s.backLabel, { color: colors.accent }]}>
                {currentLabel}
              </Text>
            </Pressable>
          )}

          {resetLabel && menuStack.length === 0 && (
            <Pressable onPress={handleReset} style={s.resetRow}>
              <Text selectable={false} style={[s.resetText, { color: colors.sub }]}>
                {resetLabel}
              </Text>
            </Pressable>
          )}

          <Animated.View
            style={[
              lockMenuHeightLayout ? { flex: 1, minHeight: 0 } : undefined,
              {
                opacity: contentFadeAnim,
              },
            ]}
          >
            {/* Single place for custom content so the same instance stays mounted when opening picker (year/month) */}
            {activeCustomLevel ? (
              <View
                style={{
                  flex: 1,
                  display: topLevel?.type === "custom" ? "flex" : "none",
                  minHeight: 0,
                }}
              >
                <ScrollView
                  style={{
                    maxHeight: dropH - (menuStack.length > 0 ? BACK_ROW_HEIGHT : 0) - 8,
                  }}
                  bounces={false}
                  showsVerticalScrollIndicator={true}
                  nestedScrollEnabled={Platform.OS === "android"}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ flexGrow: 0 }}
                >
                  {activeCustomLevel.contentFn({
                    onClose: handleClose,
                    openSubmenu,
                  })}
                </ScrollView>
              </View>
            ) : null}
            {/* Root (topLevel == null), list, or picker: show items list */}
            {(!topLevel || topLevel?.type === "picker" || topLevel?.type === "list") ? (
              <View
                style={[
                  lockMenuHeightLayout ? { flex: 1, minHeight: 0 } : undefined,
                  activeCustomLevel ? StyleSheet.absoluteFillObject : undefined,
                ]}
              >
                <ScrollView
                  style={
                    lockMenuHeightLayout
                      ? { flex: 1 }
                      : { maxHeight: listScrollMaxH }
                  }
                  contentContainerStyle={{ flexGrow: 0 }}
                  bounces={false}
                  showsVerticalScrollIndicator={true}
                  nestedScrollEnabled={Platform.OS === "android"}
                  keyboardShouldPersistTaps="handled"
                >
                  {currentItems.map(renderItem)}
                </ScrollView>
              </View>
            ) : null}
          </Animated.View>
        </Animated.View>
      </Modal>
    </View>
  );
}

/* ── Helpers ────────────────────────────────────────────────── */

function collectAllLabels(items: SelectItem[]): string[] {
  const labels: string[] = [];
  for (const item of items) {
    if ("label" in item) labels.push(item.label);
    if ("type" in item && item.type === "submenu") {
      labels.push(...collectAllLabels(item.children));
    }
    if ("type" in item && item.type === "custom") labels.push(item.label);
  }
  return labels;
}

/* ── Styles ─────────────────────────────────────────────────── */

const s = StyleSheet.create({
  selectWrap: {
    alignSelf: "flex-start",
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  selectLabel: {
    fontSize: 12,
    fontWeight: "500",
    flex: 1,
  },
  labelSpacer: { flex: 1 },
  resetBtn: {
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  resetBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
    opacity: 0.9,
    maxWidth: 320,
  },
  trigger: {
    overflow: "hidden",
    borderRadius: 12,
    alignSelf: "flex-start",
    flexShrink: 0,
  },
  triggerPress: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 40,
  },
  triggerText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.2,
    marginRight: 6,
  },

  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },

  menu: {
    position: "absolute",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    paddingVertical: DROPDOWN_PAD,
    ...Platform.select({
      web: {
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      } as any,
      default: {
        elevation: 12,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 16,
      },
    }),
  },

  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    height: BACK_ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 2,
  },
  backLabel: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.2,
  },

  resetRow: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignItems: "flex-end",
  },
  resetText: {
    fontSize: 13,
    fontWeight: "600",
  },

  groupRow: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: GROUP_HEIGHT,
    justifyContent: "center",
  },
  groupHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 22,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  groupSubtitle: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 16,
    letterSpacing: 0,
    textTransform: "none",
  },
  groupSubtitleWrap: {
    marginTop: 6,
  },

  option: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    minHeight: ITEM_HEIGHT,
  },
  optionIcon: {
    marginRight: 10,
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "500",
  },
  optionTextBold: {
    fontWeight: "700",
  },

  radio: {
    width: RADIO_SIZE,
    height: RADIO_SIZE,
    borderRadius: RADIO_SIZE / 2,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 10,
  },
  radioSquare: {
    borderRadius: 6,
  },
  radioDot: {
    width: RADIO_DOT,
    height: RADIO_DOT,
    borderRadius: RADIO_DOT / 2,
  },
  radioDotSquare: {
    borderRadius: 3,
  },
});
