import { getGallery, getRandomGalleryId, initCdn } from "@/api/v2";
import { galleryToBook } from "@/api/v2/compat";
import { resolveImageUrl } from "@/api/v2/config";
import { useAuthBridge } from "@/hooks/useAuthBridge";
import { useI18n } from "@/lib/i18n/I18nContext";
import { useTheme } from "@/lib/ThemeContext";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable as RNPressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  Pressable as RNGHPressable,
  ScrollView as GHScrollView,
} from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const SheetPressable = Platform.OS === "web" ? RNPressable : RNGHPressable;

const SHEET_BG = "#232123";
const TILE = "#312E31";
const SHEET_MAX_WIDTH = 391;
const ICON_BOX = 60;
const ICON_RADIUS = 15;
const ICON_LABEL_GAP = 6;
const LABEL_W = 80;
const LABEL_BLOCK_H = 32;
const CELL_H = ICON_BOX + ICON_LABEL_GAP + LABEL_BLOCK_H;
const ROW_GAP = 15;
const COL_GAP = 35;
const TOP_RADIUS = 15;
const GRID_H_PAD = 23;
const OPEN_SPRING = { tension: 64, friction: 12 };
const LOGO = require("@/assets/images/adaptive-icon.png");

/** RN Animated + PanResponder — совместимо с web/Electron (нет scheduleOnUI из Reanimated). */
const USE_NATIVE_DRIVER = Platform.OS !== "web";

type Item =
  | {
      key: string;
      icon: React.ComponentProps<typeof Feather>["name"];
      labelKey: string;
      action: "route";
      path: string;
    }
  | { key: string; labelKey: string; action: "random" }
  | {
      key: string;
      icon: React.ComponentProps<typeof Feather>["name"];
      labelKey: string;
      action: "reload";
    };

const MENU_ITEMS: Item[] = [
  { key: "home", icon: "home", labelKey: "menu.home", action: "route", path: "/" },
  {
    key: "favOnline",
    icon: "heart",
    labelKey: "menu.favoritesOnline",
    action: "route",
    path: "/favoritesOnline",
  },
  {
    key: "bookmarks",
    icon: "bookmark",
    labelKey: "menu.favorites",
    action: "route",
    path: "/favorites",
  },
  { key: "history", icon: "clock", labelKey: "menu.history", action: "route", path: "/history" },
  {
    key: "reco",
    icon: "star",
    labelKey: "menu.recommendations",
    action: "route",
    path: "/recommendations",
  },
  {
    key: "chars",
    icon: "package",
    labelKey: "menu.characters",
    action: "route",
    path: "/characters",
  },
  {
    key: "settings",
    icon: "settings",
    labelKey: "menu.settings",
    action: "route",
    path: "/settings",
  },
  { key: "random", labelKey: "menu.random", action: "random" },
  {
    key: "dl",
    icon: "download",
    labelKey: "menu.downloaded",
    action: "route",
    path: "/downloaded",
  },
  {
    key: "reload",
    icon: "refresh-cw",
    labelKey: "cloudflare.actions.reload",
    action: "reload",
  },
];

export type BrowseOptionsSheetProps = {
  visible: boolean;
  onClose: () => void;
  onReload: () => void | Promise<void>;
};

export function BrowseOptionsSheet({ visible, onClose, onReload }: BrowseOptionsSheetProps) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { width, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { me } = useAuthBridge(t);
  const [randBusy, setRandBusy] = useState(false);

  const translateY = useRef(new Animated.Value(0)).current;
  const backdropOp = useRef(new Animated.Value(0)).current;
  const dragStartY = useRef(0);
  /** Прокрутка меню внутри шита — свайп «вниз» закрывает только у верхней границы (overscroll). */
  const scrollYRef = useRef(0);
  const maxSlideRef = useRef(Math.min(winH * 0.92, winH - insets.top));

  const maxSlide = useMemo(() => Math.min(winH * 0.92, winH - insets.top), [winH, insets.top]);
  maxSlideRef.current = maxSlide;

  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible && !wasVisible.current) {
      scrollYRef.current = 0;
      translateY.setValue(maxSlide);
      backdropOp.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          ...OPEN_SPRING,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.timing(backdropOp, {
          toValue: 1,
          duration: 220,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ]).start();
    }
    wasVisible.current = visible;
  }, [visible, maxSlide, translateY, backdropOp]);

  const runCloseAnim = useCallback(
    (then?: () => void) => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: maxSlide,
          duration: 260,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.timing(backdropOp, {
          toValue: 0,
          duration: 200,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ]).start(({ finished }) => {
        if (finished) then?.();
      });
    },
    [backdropOp, maxSlide, translateY]
  );

  const snapClose = useCallback(() => {
    runCloseAnim(onClose);
  }, [onClose, runCloseAnim]);

  const closeSheet = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      runCloseAnim(() => {
        onClose();
        resolve();
      });
    });
  }, [onClose, runCloseAnim]);

  const pullToDismissGesture = (g: { dy: number; dx: number }) =>
    g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 0.65;

  const scrollRef = useRef<React.ComponentRef<typeof GHScrollView>>(null);
  const panDismissMovedRef = useRef(false);

  const snapDragStart = useCallback(() => {
    panDismissMovedRef.current = false;
    translateY.stopAnimation((v) => {
      dragStartY.current = v;
    });
  }, [translateY]);

  const applyPanDragIfAllowed = useCallback(
    (translationY: number) => {
      if (scrollYRef.current > 8) return;
      panDismissMovedRef.current = true;
      const next = Math.max(0, dragStartY.current + translationY);
      translateY.setValue(next);
      const m = maxSlideRef.current;
      const bop = m > 0 ? Math.max(0, Math.min(1, 1 - next / m)) : 1;
      backdropOp.setValue(bop);
    },
    [backdropOp, translateY]
  );

  const finalizePanRelease = useCallback(
    (vyIn?: number) => {
      const threshold = Math.min(120, maxSlideRef.current * 0.14);
      const vyDismiss = Platform.OS === "web" ? 0.2 : 0.45;
      translateY.stopAnimation((cur) => {
        const vy = vyIn ?? 0;
        const velocityDismiss =
          panDismissMovedRef.current && vy > vyDismiss;
        if (cur > threshold || velocityDismiss) {
          runCloseAnim(onClose);
        } else {
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              ...OPEN_SPRING,
              useNativeDriver: USE_NATIVE_DRIVER,
            }),
            Animated.timing(backdropOp, {
              toValue: 1,
              duration: 200,
              useNativeDriver: USE_NATIVE_DRIVER,
            }),
          ]).start();
        }
      });
    },
    [backdropOp, onClose, runCloseAnim, translateY]
  );

  const panGrantMoveRelease = {
    onPanResponderGrant: () => {
      panDismissMovedRef.current = false;
      translateY.stopAnimation((v) => {
        dragStartY.current = v;
      });
    },
    onPanResponderMove: (_: unknown, g: { dy: number }) => {
      panDismissMovedRef.current = true;
      const next = Math.max(0, dragStartY.current + g.dy);
      translateY.setValue(next);
      const m = maxSlideRef.current;
      const bop = m > 0 ? Math.max(0, Math.min(1, 1 - next / m)) : 1;
      backdropOp.setValue(bop);
    },
    onPanResponderRelease: (_: unknown, g: { vy?: number }) => {
      finalizePanRelease(g.vy);
    },
  };

  /** Web: PanResponder; native scroll перехватывает жест — см. nativeSheetPan + GHScrollView. */
  const sheetDismissPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        scrollYRef.current <= 6 && pullToDismissGesture(g),
      onMoveShouldSetPanResponderCapture: (_, g) =>
        scrollYRef.current <= 6 && pullToDismissGesture(g),
      ...panGrantMoveRelease,
    })
  ).current;

  const nativeSheetPan = useMemo(() => {
    if (Platform.OS === "web") return null;
    const { runOnJS } =
      require("react-native-reanimated") as typeof import("react-native-reanimated");
    return Gesture.Pan()
      .activeOffsetY(10)
      .failOffsetX([-44, 44])
      .simultaneousWithExternalGesture(
        scrollRef as unknown as React.RefObject<React.ComponentType<object>>
      )
      .onBegin(() => {
        runOnJS(snapDragStart)();
      })
      .onUpdate((e) => {
        runOnJS(applyPanDragIfAllowed)(e.translationY);
      })
      .onEnd((e) => {
        runOnJS(finalizePanRelease)(e.velocityY ?? 0);
      });
  }, [applyPanDragIfAllowed, finalizePanRelease, snapDragStart]);

  const goRandom = useCallback(async () => {
    if (randBusy) return;
    try {
      setRandBusy(true);
      await initCdn();
      const randomId = await getRandomGalleryId();
      const g = await getGallery(randomId);
      const b = galleryToBook(g);
      await closeSheet();
      router.push({
        pathname: "/book/[id]",
        params: { id: String(b.id), title: b.title.pretty, random: "1" },
      });
    } finally {
      setRandBusy(false);
    }
  }, [randBusy, closeSheet, router]);

  const pad = GRID_H_PAD;

  const runNav = async (path: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      /* noop */
    }
    await closeSheet();
    router.push(path as `/`);
  };

  const onAvatar = async () => {
    if (!me) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      /* noop */
    }
    const slug = (me.slug || me.username || String(me.id || "")).toString();
    await closeSheet();
    router.push({ pathname: "/profile/[id]/[slug]", params: { id: String(me.id ?? ""), slug } });
  };

  const accentRing = colors.accent + "CC";

  const sheetW = Math.min(width, SHEET_MAX_WIDTH);
  const innerW = sheetW - pad * 2;

  const backdropStyle = {
    opacity: backdropOp.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 0.55],
    }),
  };

  const sheetFrameStyle = [
    styles.sheet,
    {
      transform: [{ translateY }],
      width: sheetW,
      alignSelf: "center" as const,
      paddingBottom: Math.max(insets.bottom, 14),
      maxHeight: maxSlide,
    },
  ];

  const sheetScrollMaxHeight = Math.max(
    160,
    maxSlide - Math.max(insets.bottom, 14)
  );

  const scrollContent = (
    <>
        <View style={styles.headerRow}>
          <View style={styles.brandBlock}>
            <Image source={LOGO} style={styles.logo} resizeMode="cover" />
            <View style={styles.brandText}>
              <Text style={styles.brandTitle}>{t("menu.brand")}</Text>
              <Text style={styles.brandSub} numberOfLines={2}>
                {t("menu.brandSubtitle")}
              </Text>
            </View>
          </View>
          <SheetPressable
            onPress={onAvatar}
            style={({ pressed }) => [
              styles.avatarRing,
              { borderColor: accentRing },
              pressed && { opacity: 0.88 },
            ]}
            disabled={!me}
          >
            {me?.avatar_url ? (
              <Image source={{ uri: resolveImageUrl(me.avatar_url) }} style={styles.avatar} />
            ) : (
              <Image source={LOGO} style={styles.avatar} resizeMode="cover" />
            )}
          </SheetPressable>
        </View>

        <View style={[styles.grid, { width: innerW }]}>
          {MENU_ITEMS.map((item) => {
            const label = t(item.labelKey);
            const busy = item.action === "random" && randBusy;
            return (
              <SheetPressable
                key={item.key}
                onPress={() => {
                  if (item.action === "route") void runNav(item.path);
                  else if (item.action === "random") void goRandom();
                  else {
                    void (async () => {
                      try {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      } catch {
                        /* noop */
                      }
                      try {
                        await Promise.resolve(onReload());
                      } finally {
                        await closeSheet();
                      }
                    })();
                  }
                }}
                style={({ pressed }) => [styles.cell, pressed && { opacity: 0.86 }]}
                disabled={busy}
              >
                <View style={styles.tile}>
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : item.action === "random" ? (
                    <Ionicons name="wine-outline" size={24} color="#FFFFFF" />
                  ) : (
                    <Feather
                      name={(item as Extract<Item, { icon: string }>).icon}
                      size={24}
                      color="#FFFFFF"
                    />
                  )}
                </View>
                <Text style={styles.cellLabel} numberOfLines={2}>
                  {label}
                </Text>
              </SheetPressable>
            );
          })}
        </View>
    </>
  );

  const sheetScrollProps = {
    nestedScrollEnabled: true as boolean,
    keyboardShouldPersistTaps: "handled" as const,
    showsVerticalScrollIndicator: Platform.OS !== "web",
    bounces: Platform.OS === "ios",
    style: { maxHeight: sheetScrollMaxHeight },
    contentContainerStyle: {
      paddingHorizontal: pad,
      paddingBottom: 12,
    },
    scrollEventThrottle: 16,
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollYRef.current = e.nativeEvent.contentOffset.y;
    },
  };

  const sheetBody = (
    <>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: SHEET_BG }]} pointerEvents="none" />
      {Platform.OS === "web" ? (
        <ScrollView {...sheetScrollProps}>{scrollContent}</ScrollView>
      ) : (
        <GHScrollView ref={scrollRef} {...sheetScrollProps}>
          {scrollContent}
        </GHScrollView>
      )}
    </>
  );

  const sheetFrame = (
    <Animated.View style={sheetFrameStyle}>
      {sheetBody}
    </Animated.View>
  );

  return (
    <Modal visible={visible} animationType="none" transparent statusBarTranslucent onRequestClose={snapClose}>
      <GestureHandlerRootView style={styles.modalRoot}>
        <View style={styles.gestureRoot}>
          <Animated.View style={[styles.backdrop, backdropStyle]}>
            <RNPressable style={StyleSheet.absoluteFill} onPress={snapClose} />
          </Animated.View>

          {Platform.OS === "web" ? (
            <Animated.View style={sheetFrameStyle} {...sheetDismissPan.panHandlers}>
              {sheetBody}
            </Animated.View>
          ) : nativeSheetPan ? (
            <GestureDetector gesture={nativeSheetPan}>{sheetFrame}</GestureDetector>
          ) : (
            sheetFrame
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
  },
  gestureRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    zIndex: 0,
  },
  sheet: {
    borderTopLeftRadius: TOP_RADIUS,
    borderTopRightRadius: TOP_RADIUS,
    overflow: "hidden",
    backgroundColor: SHEET_BG,
    zIndex: 2,
    ...Platform.select({
      android: { elevation: 40 },
      web: {
        boxShadow: "0 0 4px rgba(0,0,0,0.25)",
        maxWidth: "100%",
      },
      default: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: -6 },
        shadowOpacity: 0.35,
        shadowRadius: 16,
      },
    }),
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#312E31",
    gap: 12,
  },
  brandBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 8,
  },
  brandText: {
    flex: 1,
    minWidth: 0,
  },
  brandTitle: {
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  brandSub: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "500",
    color: "#C4BBC4",
    marginTop: 0,
  },
  avatarRing: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    padding: 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: ROW_GAP,
    columnGap: COL_GAP,
    paddingTop: 15,
    paddingBottom: 15,
    alignContent: "flex-start",
  },
  cell: {
    width: ICON_BOX,
    height: CELL_H,
    alignItems: "center",
    overflow: "visible",
  },
  tile: {
    width: ICON_BOX,
    height: ICON_BOX,
    backgroundColor: TILE,
    borderRadius: ICON_RADIUS,
    alignItems: "center",
    justifyContent: "center",
  },
  cellLabel: {
    marginTop: ICON_LABEL_GAP,
    width: LABEL_W,
    minHeight: LABEL_BLOCK_H,
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400",
    color: "#FFFFFF",
    textAlign: "center",
    ...Platform.select({
      web: {
        wordBreak: "break-word",
        overflowWrap: "break-word",
      },
      default: {},
    }),
  },
});
