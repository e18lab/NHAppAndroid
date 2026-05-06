import { fetchBooksFromRecommendationLib } from "@/api/nhappApi/recommendationLib";
import type { Book } from "@/api/nhappApi/types";
import { useI18n } from "@/lib/i18n/I18nContext";
import { useTheme } from "@/lib/ThemeContext";
import { LinearGradient } from "expo-linear-gradient";
import React, {
  ReactElement,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  FlatList,
  ListRenderItem,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import BookCard from "./BookCard";
import FastScrollRail, { type FastScrollRailHandle } from "./FastScrollRail";
import LoadingSpinner from "./LoadingSpinner";

export interface GridConfig {
  numColumns: number;
  minColumnWidth?: number;
  paddingHorizontal?: number;
  columnGap?: number;
}

export interface BookListProps<T extends Book = Book> {
  data: T[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onEndReached?: () => void;
  ListEmptyComponent?: ReactNode;
  ListFooterComponent?: ReactElement | null;
  ListHeaderComponent?: ReactElement | null;
  isFavorite?: (id: number) => boolean;
  onToggleFavorite?: (id: number, next: boolean) => void;
  onPress?: (id: number) => void;
  renderItem?: ListRenderItem<T>;
  gridConfig?: {
    phonePortrait?: GridConfig;
    phoneLandscape?: GridConfig;
    tabletPortrait?: GridConfig;
    tabletLandscape?: GridConfig;
    default?: GridConfig;
  };
  horizontal?: boolean;
  background?: string;
  getScore?: (book: T) => number | undefined;
  columnWrapperStyle?: any;
  children?: ReactNode;
  scrollRef?: React.RefObject<FlatList<T> | null>;
  onScrollHorizontal?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

const _isWebGrid = Platform.OS === "web";

export default function BookList<T extends Book = Book>({
  data,
  loading,
  refreshing,
  onRefresh,
  onEndReached,
  ListEmptyComponent,
  ListFooterComponent,
  ListHeaderComponent,
  isFavorite: _isFavorite,
  onToggleFavorite: _onToggleFavorite,
  onPress,
  renderItem,
  gridConfig,
  horizontal = false,
  background,
  getScore: _getScore,
  columnWrapperStyle,
  children,
  scrollRef: externalScrollRef,
  onScrollHorizontal,
}: BookListProps<T>) {
  const { colors } = useTheme();
  const internalListRef = useRef<FlatList<T> | null>(null);
  const listRef = (externalScrollRef || internalListRef) as React.RefObject<FlatList<T>>;
  const { width, height } = useWindowDimensions();

  const themeBg =
    background ??
    (colors as any).page ??
    (colors as any).surfaceElevated ??
    (colors as any).bg ??
    "#1C1C1C";

  const base = useMemo<GridConfig>(() => {
    const isPortrait = height > width;
    const isTablet = width > 600;
    return isTablet
      ? gridConfig?.tabletLandscape ??
          gridConfig?.tabletPortrait ??
          gridConfig?.default ?? { numColumns: 4 }
      : !isPortrait
      ? gridConfig?.phoneLandscape ?? gridConfig?.default ?? { numColumns: 3 }
      : gridConfig?.phonePortrait ?? gridConfig?.default ?? { numColumns: 2 };
  }, [width, height, gridConfig]);

  const {
    cols,
    cardWidth,
    columnGap,
    paddingHorizontal,
    uniqueData,
    estCardH,
  } = useMemo(() => {
    const padH = base.paddingHorizontal ?? 0;
    const gap = base.columnGap ?? 0;
    const minW = base.minColumnWidth ?? 80;
    const avail = Math.max(0, width - padH * 2);

    const uniq = (() => {
      const seen = new Set<number>();
      return data.filter((b) =>
        seen.has(b.id) ? false : (seen.add(b.id), true)
      );
    })();

    if (horizontal) {
      const cap = width >= 1000 ? 260 : width >= 768 ? 240 : 210;
      const visible = Math.max(1, base.numColumns || 3);
      const w = (avail - gap * (visible - 1)) / visible;
      const cw = Math.min(Math.max(minW, w), cap);
      const estH = Math.round(cw * 1.35);
      return {
        cols: 1,
        cardWidth: cw,
        columnGap: gap,
        paddingHorizontal: padH,
        uniqueData: uniq,
        estCardH: estH,
      };
    }

    const maxCols = Math.max(
      1,
      Math.min(base.numColumns, Math.floor((avail + gap) / (minW + gap)))
    );
    const cw = (avail - gap * (maxCols - 1)) / maxCols;
    const estH = Math.round(cw * 1.35);

    return {
      cols: maxCols,
      cardWidth: cw,
      columnGap: gap,
      paddingHorizontal: padH,
      uniqueData: uniq,
      estCardH: estH,
    };
  }, [data, width, base, horizontal]);
  const isSingleCol = !horizontal && cols === 1;
  const contentScale = isSingleCol ? 0.45 : 0.65;

  const [containerW, setContainerW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const contentHRef = useRef(0);
  const offsetYRef = useRef(0);
  const railDraggingRef = useRef(false);
  const dragMaxOffsetRef = useRef(0);
  const railRef = useRef<FastScrollRailHandle | null>(null);

  const { t } = useI18n();

  const fadeLeft = useRef(new Animated.Value(0)).current;
  const fadeRight = useRef(new Animated.Value(0)).current;

  const [enrichedById, setEnrichedById] = useState<Record<number, Book>>({});

  // Lazy enrichment queue: only fetch metadata for actually rendered cards.
  const enrichQueuedRef = useRef<Set<number>>(new Set());
  const enrichInFlightRef = useRef<Set<number>>(new Set());
  const enrichTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enrichLastFetchAtRef = useRef<number>(0);

  const flushEnrichQueue = useCallback(() => {
    if (enrichTimerRef.current) {
      clearTimeout(enrichTimerRef.current);
      enrichTimerRef.current = null;
    }
    const now = Date.now();
    const MIN_INTERVAL_MS = 10000; // don't spam backend while it scans
    if (now - enrichLastFetchAtRef.current < MIN_INTERVAL_MS) {
      enrichTimerRef.current = setTimeout(
        flushEnrichQueue,
        MIN_INTERVAL_MS - (now - enrichLastFetchAtRef.current)
      );
      return;
    }
    const queued = Array.from(enrichQueuedRef.current);
    enrichQueuedRef.current.clear();
    if (!queued.length) return;

    // Limit per flush to keep UI responsive.
    const BATCH = 25;
    const ids = queued.slice(0, BATCH);
    for (const id of ids) enrichInFlightRef.current.add(id);
    enrichLastFetchAtRef.current = Date.now();

    void (async () => {
      try {
        const enriched = await fetchBooksFromRecommendationLib(ids);
        const next: Record<number, Book> = {};
        for (const b of enriched) next[b.id] = b;
        setEnrichedById((prev) => ({ ...prev, ...next }));
      } catch {
        // offline / server down: ignore
      } finally {
        for (const id of ids) enrichInFlightRef.current.delete(id);
        // If more were queued while fetching, schedule another flush.
        if (enrichQueuedRef.current.size) {
          enrichTimerRef.current = setTimeout(flushEnrichQueue, 300);
        }
      }
    })();
  }, []);

  const requestEnrich = useCallback(
    (id: number) => {
      if (!Number.isFinite(id) || id <= 0) return;
      if (enrichedById[id]) return;
      if (enrichInFlightRef.current.has(id)) return;
      enrichQueuedRef.current.add(id);
      if (!enrichTimerRef.current) {
        enrichTimerRef.current = setTimeout(flushEnrichQueue, 300);
      }
    },
    [enrichedById, flushEnrichQueue]
  );

  const mergeEnriched = useCallback((base: T, enriched?: Book): T => {
    if (!enriched) return base;
    const bAny: any = base as any;
    const eAny: any = enriched as any;

    const pickStr = (a?: string, b?: string) => (a && a.trim() ? a : b || "");
    const pickNum = (a?: number, b?: number) =>
      typeof a === "number" && Number.isFinite(a) && a > 0 ? a : (b as any);

    const merged: any = {
      ...bAny,
      title: {
        english: pickStr(eAny?.title?.english, bAny?.title?.english),
        japanese: pickStr(eAny?.title?.japanese, bAny?.title?.japanese),
        pretty: pickStr(eAny?.title?.pretty, bAny?.title?.pretty),
      },
      uploaded: pickStr(eAny?.uploaded, bAny?.uploaded),
      pagesCount: pickNum(eAny?.pagesCount, bAny?.pagesCount) ?? bAny?.pagesCount,
      // keep favorites from base (nhentai provides it; reco-lib currently doesn't)
      favorites: typeof bAny?.favorites === "number" ? bAny.favorites : (eAny?.favorites ?? 0),
      tags: Array.isArray(eAny?.tags) && eAny.tags.length ? eAny.tags : bAny?.tags,
      artists:
        Array.isArray(eAny?.artists) && eAny.artists.length ? eAny.artists : bAny?.artists,
      characters:
        Array.isArray(eAny?.characters) && eAny.characters.length
          ? eAny.characters
          : bAny?.characters,
      parodies:
        Array.isArray(eAny?.parodies) && eAny.parodies.length ? eAny.parodies : bAny?.parodies,
      groups: Array.isArray(eAny?.groups) && eAny.groups.length ? eAny.groups : bAny?.groups,
      categories:
        Array.isArray(eAny?.categories) && eAny.categories.length
          ? eAny.categories
          : bAny?.categories,
      languages:
        Array.isArray(eAny?.languages) && eAny.languages.length
          ? eAny.languages
          : bAny?.languages,
      // keep visuals from base to avoid flicker; fill only if empty
      cover: pickStr(bAny?.cover, eAny?.cover),
      thumbnail: pickStr(bAny?.thumbnail, eAny?.thumbnail),
      coverW: pickNum(bAny?.coverW, eAny?.coverW) ?? bAny?.coverW,
      coverH: pickNum(bAny?.coverH, eAny?.coverH) ?? bAny?.coverH,
      media: pickNum(bAny?.media, eAny?.media) ?? bAny?.media,
    };
    return merged as T;
  }, []);

  useEffect(() => {
    return () => {
      if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
      enrichTimerRef.current = null;
      enrichQueuedRef.current.clear();
      enrichInFlightRef.current.clear();
    };
  }, []);

  const updateFades = (x: number, cW: number, vW: number) => {
    const canScroll = horizontal && cW > vW + 1;
    const toLeft = canScroll ? Math.min(1, x / 24) : 0;
    const toRight = canScroll ? Math.min(1, (cW - vW - x) / 24) : 0;
    Animated.timing(fadeLeft, {
      toValue: toLeft,
      duration: 160,
      useNativeDriver: true,
    }).start();
    Animated.timing(fadeRight, {
      toValue: toRight,
      duration: 160,
      useNativeDriver: true,
    }).start();
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (horizontal) {
      const x = e.nativeEvent.contentOffset.x;
      setScrollX(x);
      updateFades(x, contentW, containerW);
      onScrollHorizontal?.(e);
      return;
    }
    const y = e.nativeEvent.contentOffset.y;
    offsetYRef.current = y;
    railRef.current?.syncToOffset(y);
  };

  const renderCard: ListRenderItem<T> = useCallback(
    ({ item, index }) => {
      const isLastInRow = !horizontal && (index + 1) % cols === 0;
      const isLastHoriz = horizontal && index === uniqueData.length - 1;
      const merged = mergeEnriched(item, enrichedById[item.id]);

      const anyMerged: any = merged as any;
      const hasAnyTags =
        (Array.isArray(anyMerged?.tags) && anyMerged.tags.length > 0) ||
        (Array.isArray(anyMerged?.artists) && anyMerged.artists.length > 0) ||
        (Array.isArray(anyMerged?.languages) && anyMerged.languages.length > 0);
      if (!hasAnyTags) requestEnrich(item.id);

      return (
        <View
          style={{
            width: cardWidth,
            marginRight: horizontal
              ? isLastHoriz
                ? 0
                : columnGap
              : isLastInRow
              ? 0
              : columnGap,
            marginBottom: horizontal ? 0 : columnGap,
            ...(isSingleCol && { alignSelf: "center" }),
          }}
        >
          <BookCard
            book={merged as any}
            cardWidth={cardWidth}
            contentScale={contentScale}
            onPress={() => onPress?.(item.id)}
          />
        </View>
      );
    },
    [
      horizontal,
      cols,
      uniqueData.length,
      cardWidth,
      columnGap,
      isSingleCol,
      contentScale,
      onPress,
      enrichedById,
      mergeEnriched,
      requestEnrich,
    ]
  );

  const Empty = () => (
    <View style={styles.empty}>
      <Animated.Text style={styles.emptyText}>
        {t("booklist.notFound") || "Ничего не найдено"}
      </Animated.Text>
    </View>
  );

  const topPad = paddingHorizontal / 2;
  const bottomPad = paddingHorizontal / 2;

  const useWebGrid = _isWebGrid && !horizontal;

  // ─── Web grid: ScrollView + flex-wrap (no FlatList remount on resize) ───
  if (useWebGrid) {
    const endFiredRef = useRef(false);
    const [webScrollY, setWebScrollY] = useState(0);
    const [webViewportH, setWebViewportH] = useState(0);

    const handleWebScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      setWebScrollY(contentOffset.y);
      setWebViewportH(layoutMeasurement.height);
      const distFromEnd =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      const threshold = layoutMeasurement.height * 0.4;
      if (distFromEnd <= threshold) {
        if (!endFiredRef.current) {
          endFiredRef.current = true;
          onEndReached?.();
        }
      } else {
        endFiredRef.current = false;
      }
    };

    const emptyWeb =
      uniqueData.length === 0 && !loading
        ? ((ListEmptyComponent as ReactElement) ?? <Empty />)
        : null;

    // Enrich only visible window (avoid spamming: web grid renders all items).
    const rowH = estCardH + columnGap;
    const startRow = rowH > 0 ? Math.max(0, Math.floor(webScrollY / rowH) - 1) : 0;
    const visibleRows = rowH > 0 ? Math.ceil((webViewportH || height) / rowH) + 3 : 8;
    const startIdx = startRow * cols;
    const endIdx = Math.min(uniqueData.length, (startRow + visibleRows) * cols);
    const visibleSlice = uniqueData.slice(startIdx, endIdx);
    // Queue in render (cheap): requestEnrich is internally debounced + rate-limited.
    visibleSlice.forEach((item) => {
      const merged = mergeEnriched(item, enrichedById[item.id]);
      const anyMerged: any = merged as any;
      const hasAnyTags =
        (Array.isArray(anyMerged?.tags) && anyMerged.tags.length > 0) ||
        (Array.isArray(anyMerged?.artists) && anyMerged.artists.length > 0) ||
        (Array.isArray(anyMerged?.languages) && anyMerged.languages.length > 0);
      if (!hasAnyTags) requestEnrich(item.id);
    });

    return (
      <View
        style={[styles.container, { backgroundColor: themeBg, position: "relative" }]}
      >
        <ScrollView
          ref={listRef as unknown as React.RefObject<ScrollView>}
          style={webGridStyles.scroll}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          onScroll={handleWebScroll}
          scrollEventThrottle={16}
          contentContainerStyle={[
            webGridStyles.content,
            {
              paddingHorizontal,
              paddingTop: topPad,
              paddingBottom: bottomPad || undefined,
              flexGrow: uniqueData.length === 0 ? 1 : undefined,
            },
          ]}
        >
          {ListHeaderComponent}
          {emptyWeb ? (
            emptyWeb
          ) : (
            <View style={[webGridStyles.wrap, { gap: columnGap }]}>
              {uniqueData.map((item) => {
                const merged = mergeEnriched(item, enrichedById[item.id]);
                return (
                  <View
                    key={String(item.id)}
                    style={{ width: cardWidth }}
                  >
                    <BookCard
                      book={merged as any}
                      cardWidth={cardWidth}
                      contentScale={contentScale}
                      onPress={() => onPress?.(item.id)}
                    />
                  </View>
                );
              })}
            </View>
          )}
          {loading ? <LoadingSpinner /> : ListFooterComponent}
        </ScrollView>
        {children}
      </View>
    );
  }

  // ─── Native / horizontal: FlatList path ───
  const listKey = horizontal
    ? `row-${Math.round(cardWidth)}`
    : `cols-${cols}`;

  const canUseFixedLayout = horizontal;
  const rowHeight = estCardH + (horizontal ? 0 : columnGap);
  const getItemLayout = canUseFixedLayout && !horizontal
    ? (_: any, index: number) => {
        const row = Math.floor(index / cols);
        const offset = paddingHorizontal / 2 + row * rowHeight;
        return { length: rowHeight, offset, index };
      }
    : horizontal
      ? (_: any, index: number) => ({
          length: cardWidth + columnGap,
          offset: (cardWidth + columnGap) * index,
          index,
        })
      : undefined;

  const fadeWidth = 36;

  return (
    <View
      onLayout={(e) => {
        setContainerW(e.nativeEvent.layout.width);
        if (!horizontal) {
          const h = e.nativeEvent.layout.height;
          setViewportH(h);
        }
      }}
      style={[
        horizontal ? styles.rowContainer : styles.container,
        { backgroundColor: themeBg, position: "relative" },
      ]}
    >
      <>
        <FlatList
            ref={listRef}
            key={listKey}
            horizontal={horizontal}
            showsHorizontalScrollIndicator={false}
            decelerationRate={horizontal ? "fast" : undefined}
            snapToAlignment={horizontal ? "start" : undefined}
            data={uniqueData}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderItem ?? renderCard}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            ListEmptyComponent={
              !loading
                ? ((ListEmptyComponent as ReactElement) ?? <Empty />)
                : undefined
            }
            contentContainerStyle={{
              flexGrow: !horizontal && uniqueData.length === 0 ? 1 : undefined,
              paddingHorizontal,
              paddingTop: topPad,
              paddingBottom: bottomPad || undefined,
            }}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loading ? (
                <LoadingSpinner />
              ) : (
                ListFooterComponent
              )
            }
            ListHeaderComponent={ListHeaderComponent}
            numColumns={horizontal ? undefined : cols}
            columnWrapperStyle={
              !horizontal && cols > 1
                ? [{ justifyContent: "center" }, columnWrapperStyle]
                : undefined
            }
            getItemLayout={getItemLayout as any}
            onContentSizeChange={(w, h) => {
              if (horizontal) {
                setContentW(w);
                updateFades(scrollX, w, containerW);
              } else {
                const prev = contentHRef.current;
                const grew = h > prev + 16;
                const majorShrink = h < prev - 240;
                if (grew || majorShrink) {
                  contentHRef.current = h;
                  setContentH(h);
                  railRef.current?.syncToOffset(offsetYRef.current);
                }
              }
            }}
            onScroll={onScroll}
            scrollEventThrottle={16}
            removeClippedSubviews={Platform.OS === 'android' || !!canUseFixedLayout}
            windowSize={Platform.OS === 'android' ? 5 : 7}
            maxToRenderPerBatch={Platform.OS === 'android' ? 6 : 10}
            initialNumToRender={Platform.OS === 'android' ? Math.min(6, uniqueData.length) : Math.min(12, uniqueData.length)}
            updateCellsBatchingPeriod={Platform.OS === 'android' ? 50 : 40}
          />
          {!horizontal && Platform.OS !== "web" ? (
            <FastScrollRail
              ref={railRef}
              viewportHeight={viewportH}
              contentHeight={contentH}
              accentColor={colors.accent}
              railColor={colors.page + "77"}
              onDragStateChange={(isDragging) => {
                railDraggingRef.current = isDragging;
                if (isDragging) {
                  dragMaxOffsetRef.current = Math.max(0, contentH - viewportH);
                }
              }}
              onSeekRatio={(ratio) => {
                const maxOffset = railDraggingRef.current
                  ? dragMaxOffsetRef.current
                  : Math.max(0, contentH - viewportH);
                const nextOffset = ratio * maxOffset;
                offsetYRef.current = nextOffset;
                listRef.current?.scrollToOffset({
                  offset: nextOffset,
                  animated: false,
                });
              }}
            />
          ) : null}
          {horizontal && (
            <>
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.fade,
                  {
                    left: 0,
                    width: fadeWidth,
                    top: 0,
                    bottom: 0,
                    opacity: fadeLeft,
                  },
                ]}
              >
                <LinearGradient
                  colors={[themeBg, "transparent"]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.fade,
                  {
                    right: 0,
                    width: fadeWidth,
                    top: 0,
                    bottom: 0,
                    opacity: fadeRight,
                  },
                ]}
              >
                <LinearGradient
                  colors={["transparent", themeBg]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
            </>
          )}
        </>
      {children}
    </View>
  );
}

const webGridStyles = StyleSheet.create({
  scroll: Platform.OS === "web" ? { flex: 1, width: "100%" } : {},
  content: Platform.OS === "web" ? { width: "100%", flexGrow: 1 } : {},
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    ...(Platform.OS === "web" ? { width: "100%" } : {}),
  },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  rowContainer: { flexGrow: 0 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText: { color: "#888", fontSize: 16 },
  loader: { marginVertical: 16 },
  fade: { position: "absolute", zIndex: 5 },
});
