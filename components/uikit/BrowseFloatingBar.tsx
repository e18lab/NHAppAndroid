/**
 * Floating browse chrome — prev / search+title / page+menu / next (Figma Frame 9234).
 */
import { Feather, Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
const OUTER_BG_TOP = "rgba(17, 15, 17, 0.9)";
const OUTER_BG_BOTTOM = "#110F11";
const SEGMENT_BG = "#232123";
const SEGMENT_SHADOW = "#00000040";
const TXT = "#FFFFFF";

function formatThousands(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export type BrowseFloatingBarProps = {
  currentPage: number;
  totalPages: number;
  /** Total hit count from API (shown as “1/32 546”). Falls back to totalPages if omitted. */
  totalItems?: number;
  title: string;
  onPrev: () => void;
  onNext: () => void;
  onSearchHomePress: () => void;
  onMenuPress: () => void;
  canPrev: boolean;
  canNext: boolean;
  style?: ViewStyle;
};

export function BrowseFloatingBar({
  currentPage,
  totalPages,
  totalItems,
  title,
  onPrev,
  onNext,
  onSearchHomePress,
  onMenuPress,
  canPrev,
  canNext,
  style,
}: BrowseFloatingBarProps) {
  const insets = useSafeAreaInsets();
  const bottomOffset = 15 + insets.bottom;
  const pageLabel = useMemo(() => {
    const rhs =
      totalItems != null && totalItems > 0
        ? formatThousands(totalItems)
        : String(totalPages);
    return `${currentPage}/${rhs}`;
  }, [currentPage, totalItems, totalPages]);

  const bump = () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      /* noop */
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.shell,
        Platform.OS === "web"
          ? [
              styles.fixedViewport,
              {
                bottom: bottomOffset,
                left: 15,
                right: 15,
              },
            ]
          : [
              styles.absoluteLayer,
              {
                bottom: bottomOffset,
                left: 15,
                right: 15,
              },
            ],
        style,
      ]}
    >
      {Platform.OS === "ios" ? (
        <BlurView
          intensity={28}
          tint="dark"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <LinearGradient
        colors={[OUTER_BG_TOP, OUTER_BG_BOTTOM]}
        locations={[0, 1]}
        style={styles.outer}
      >
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            disabled={!canPrev}
            onPress={() => {
              if (!canPrev) return;
              bump();
              onPrev();
            }}
            style={({ pressed }) => [
              styles.sideBtn,
              {
                opacity: !canPrev ? 0.35 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <Ionicons name="chevron-back" size={18} color={TXT} />
          </Pressable>

          <View style={styles.centerShell}>
            <Pressable
              onPress={onSearchHomePress}
              style={styles.centerLeft}
              accessibilityRole="button"
              accessibilityLabel={`Search, ${title}`}
            >
              <Feather name="search" size={16} color={TXT} />
              <Text style={styles.titleTxt} numberOfLines={1}>
                {title}
              </Text>
            </Pressable>

            <View style={styles.centerRight}>
              <Text style={styles.pageTxt} numberOfLines={1}>
                {pageLabel}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Menu"
                onPress={() => {
                  bump();
                  onMenuPress();
                }}
                style={({ pressed }) => [
                  styles.menuHit,
                  pressed && { opacity: 0.75 },
                ]}
                hitSlop={8}
              >
                <Feather name="more-vertical" size={16} color={TXT} />
              </Pressable>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next page"
            disabled={!canNext}
            onPress={() => {
              if (!canNext) return;
              bump();
              onNext();
            }}
            style={({ pressed }) => [
              styles.sideBtn,
              {
                opacity: !canNext ? 0.35 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <Ionicons name="chevron-forward" size={18} color={TXT} />
          </Pressable>
        </View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 14,
    overflow: "hidden",
    zIndex: 999999,
    ...Platform.select({
      android: { elevation: 24 },
      web: {
        boxShadow: `0px 0px 4px ${SEGMENT_SHADOW}`,
      },
      default: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
    }),
  },
  absoluteLayer: {
    position: "absolute",
  },
  fixedViewport: {
    position: "fixed" as unknown as ViewStyle["position"],
  },
  outer: {
    padding: 5,
    borderRadius: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 40,
  },
  sideBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: SEGMENT_BG,
    borderRadius: 10,
    ...Platform.select({
      android: { elevation: 2 },
      web: { boxShadow: `0px 0px 4px ${SEGMENT_SHADOW}` },
      default: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
    }),
  },
  centerShell: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    paddingVertical: 2,
    minHeight: 40,
    backgroundColor: SEGMENT_BG,
    borderRadius: 10,
    ...Platform.select({
      android: { elevation: 2 },
      web: { boxShadow: `0px 0px 4px ${SEGMENT_SHADOW}` },
      default: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
    }),
  },
  centerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 8,
    paddingVertical: 6,
    flexShrink: 1,
    maxWidth: "52%",
  },
  titleTxt: {
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "600",
    color: TXT,
  },
  centerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingRight: 2,
    flexShrink: 0,
  },
  pageTxt: {
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "600",
    color: TXT,
  },
  menuHit: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
});
