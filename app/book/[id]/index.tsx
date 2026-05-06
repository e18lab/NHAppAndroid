import type { Book } from "@/api/nhappApi/types";
import { getRandomGalleryId, getGallery, initCdn } from "@/api/v2";
import { galleryToBook } from "@/api/v2/compat";
import { loadBookFromLocal } from "@/api/nhappApi/localBook";
import LoadingSpinner from "@/components/LoadingSpinner";
import FastScrollRail, {
  type FastScrollRailHandle,
} from "@/components/FastScrollRail";
import PageItem, { GAP } from "@/components/book/PageItem";
import { RESET_TAGS_ON_BOOK_TAG_NAV_KEY } from "@/components/settings/keys";
import { useFilterTags } from "@/context/TagFilterContext";
import { useGridConfig } from "@/hooks/useGridConfig";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useTheme } from "@/lib/ThemeContext";
import {
  getDownloadProgressSnapshot,
  subscribeDownloadProgress,
} from "@/lib/downloadProgressStore";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useState,
} from "react";
 
import {
  Animated,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { isElectron, openReaderWindow } from "@/electron/bridge";
import { useBookData } from "@/hooks/book/useBookData";
import { useColumns } from "@/hooks/book/useColumns";
import { useDownload } from "@/hooks/book/useDownload";
import { useFab } from "@/hooks/book/useFab";
import { useFavorites } from "@/hooks/book/useFavorites";
import { useRelatedComments } from "@/hooks/book/useRelatedComments";
import { useWindowLayout } from "@/hooks/book/useWindowLayout";
import { useI18n } from "@/lib/i18n/I18nContext";

import BookHeader from "./_components/BookHeader";
import RelatedSection from "./_components/RelatedSection";

export default function BookScreen() {
  const { id, random } = useLocalSearchParams<{ id: string; random?: string }>();
  const idNum = Number(id);
  const fromRandom = random === "1";

  const router = useRouter();
  const { colors } = useTheme();
  const baseGrid = useGridConfig();
  const { t } = useI18n();
  const { filters, cycle } = useFilterTags();
  const [resetTagsOnBookTagNav] = usePersistedState<boolean>(
    RESET_TAGS_ON_BOOK_TAG_NAV_KEY,
    false,
    { syncToCloud: true }
  );
  const { win, wide, innerPadding } = useWindowLayout();
  const { book, setBook, local, setLocal } = useBookData(idNum);
  const {
    related,
    relLoading,
    refetchRelated,
    allComments,
    visibleCount,
    setVisibleCount,
    cmtLoading,
    refetchComments,
  } = useRelatedComments(book);
  const { favorites, toggleFav } = useFavorites(idNum);
  const { dl, pr, handleDownloadOrDelete, cancel } = useDownload(book, local, setLocal, setBook);
  const { cols, cycleCols, listRef, setScrollY } = useColumns(wide);
  const {
    fabScale,
    onScroll: onScrollFab,
    handleFabPress,
    scrollDirection,
    listRef: fabListRef,
  } = useFab();

  const [listW, setListW] = useState(win.w);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);
  const contentHRef = useRef(0);
  const offsetYRef = useRef(0);
  const railDraggingRef = useRef(false);
  const dragMaxOffsetRef = useRef(0);
  const railRef = useRef<FastScrollRailHandle | null>(null);
  const [rndLoading, setRndLoading] = useState(false);
  const [showAllPages, setShowAllPages] = useState(false);
  const scrollPositionRef = useRef<number>(0);
  const prevDataLengthRef = useRef<number>(0);
  const prevColsRef = useRef<number>(cols);

  const dlSnap = useSyncExternalStore(
    subscribeDownloadProgress,
    getDownloadProgressSnapshot,
    getDownloadProgressSnapshot
  );
  const isGlobalDownloadingThis =
    !!book?.id && dlSnap.active && dlSnap.bookId === book.id;
  const dlUi = dl || isGlobalDownloadingThis;
  const prUi = dl ? pr : isGlobalDownloadingThis ? dlSnap.progress : 0;

  // If the book finished downloading elsewhere, refresh local state immediately.
  useEffect(() => {
    if (!book?.id) return;
    if (!dlSnap.lastFinishedAt) return;
    if (dlSnap.lastFinishedBookId !== book.id) return;
    if (local) return;

    let cancelled = false;
    (async () => {
      const bLocal = await loadBookFromLocal(book.id);
      if (cancelled) return;
      if (bLocal) {
        setBook(bLocal);
        setLocal(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book?.id, dlSnap.lastFinishedAt, dlSnap.lastFinishedBookId, local, setBook, setLocal]);

  useEffect(() => { setListW(win.w); }, [win.w]);

  useEffect(() => {
    if (prevColsRef.current !== cols && scrollPositionRef.current > 0) {
      const currentScrollY = scrollPositionRef.current;
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (listRef.current && currentScrollY > 0) {
            listRef.current.scrollToOffset({ offset: currentScrollY, animated: false });
          }
        }, 150);
      });
    }
    prevColsRef.current = cols;
  }, [cols]);

  const modeOf = useCallback(
    (tag: { type: string; name: string }): "include" | "exclude" | undefined => {
      const m = filters.find((f) => f.type === tag.type && f.name === tag.name)?.mode;
      return m === "include" || m === "exclude" ? m : undefined;
    },
    [filters]
  );

  useEffect(() => {
    if (book?.title?.pretty) router.setParams({ title: book.title.pretty });
  }, [book?.title?.pretty]);

  const horizPad = Math.max(0, innerPadding - GAP / 2);

  const headerEl = !book ? null : (
    <BookHeader
      book={book}
      containerW={listW || win.w}
      pad={innerPadding}
      wide={wide}
      cols={cols}
      cycleCols={cycleCols}
      bookmarked={favorites.has(book.id)}
      onToggleBookmark={() => toggleFav(book.id, !favorites.has(book.id))}
      dl={dlUi}
      pr={prUi}
      local={local}
      handleDownloadOrDelete={dlUi ? () => {} : handleDownloadOrDelete}
      modeOf={modeOf}
      onTagPress={(name: any) =>
        router.push({
          pathname: "/explore",
          params: resetTagsOnBookTagNav
            ? { query: name, solo: "1" }
            : { query: name },
        })
      }
      win={win}
      innerPadding={innerPadding}
      cycle={cycle}
      cancel={dl ? cancel : () => {}}
      commentCount={allComments.length}
    />
  );

  const limitedPages = useMemo(() => {
    if (!book?.pages || showAllPages) return book?.pages || [];
    const rows = Math.floor(24 / cols);
    return book.pages.slice(0, rows * cols);
  }, [book?.pages, cols, showAllPages]);

  useEffect(() => {
    if (showAllPages && prevDataLengthRef.current > 0) {
      const currentScrollY = scrollPositionRef.current;
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (listRef.current && currentScrollY > 0) {
            listRef.current.scrollToOffset({ offset: currentScrollY, animated: false });
          }
        }, 100);
      });
    }
    prevDataLengthRef.current = limitedPages.length;
  }, [showAllPages, limitedPages.length]);

  const showAllButton = useMemo(() => {
    if (showAllPages || !book?.pages || limitedPages.length >= book.pages.length) return null;
    return (
      <View style={{ paddingVertical: 20, paddingHorizontal: horizPad, alignItems: "center" }}>
        <Pressable
          onPress={() => setShowAllPages(true)}
          android_ripple={{ color: "#ffffff22", borderless: false }}
          style={({ pressed }) => [
            { backgroundColor: colors.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8, minWidth: 120, alignItems: "center" },
            pressed && (Platform.select({ android: { opacity: 0.96, transform: [{ scale: 0.995 }] }, ios: { opacity: 0.85 } }) as any),
          ]}
        >
          <Text style={{ color: colors.bg, fontSize: 14, fontWeight: "600" }}>
            {t("book.showAll") || "Show all"}
          </Text>
        </Pressable>
      </View>
    );
  }, [showAllPages, book?.pages, limitedPages.length, horizPad, colors, t]);

  const footerEl = useMemo(
    () => (
      <RelatedSection
        related={related}
        relLoading={relLoading}
        refetchRelated={refetchRelated}
        favorites={favorites}
        toggleFav={toggleFav}
        baseGrid={baseGrid}
        innerPadding={innerPadding}
      />
    ),
    [related, relLoading, refetchRelated, favorites, toggleFav, baseGrid, innerPadding]
  );

  const itemW = useMemo(() => {
    const availableWidth = Math.max(100, (listW || win.w) - 2 * horizPad);
    if (cols === 1) return availableWidth;
    const calculated = Math.floor((availableWidth - (cols - 1) * GAP) / cols);
    return Math.max(100, Math.min(calculated, availableWidth));
  }, [cols, listW, win.w, horizPad]);

  const imageHeights = useMemo(() => {
    if (!limitedPages.length) return [];
    return limitedPages.map((page) => {
      const ar = page.width / page.height;
      const isVertical = page.height > page.width;
      const isSuperLong = isVertical && page.height > page.width * 3;
      const maxH = isSuperLong ? itemW * 2.5 : undefined;
      return maxH ? Math.min(itemW / ar, maxH) : itemW / ar;
    });
  }, [limitedPages, itemW]);

  const openPage = useCallback(
    async (pageNum: number) => {
      const bid = book?.id;
      if (bid == null) return;
      if (isElectron()) {
        const ok = await openReaderWindow(bid, pageNum);
        if (!ok) router.push({ pathname: "/read", params: { id: String(bid), page: String(pageNum) } });
      } else {
        router.push({ pathname: "/read", params: { id: String(bid), page: String(pageNum) } });
      }
    },
    [book?.id, router]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Book["pages"][number]; index: number }) => {
      let showBackground = false;
      if (cols > 1) {
        const rowIndex = Math.floor(index / cols);
        const rowStart = rowIndex * cols;
        const rowEnd = Math.min(rowStart + cols, imageHeights.length);
        const rowHeights = imageHeights.slice(rowStart, rowEnd);
        if (rowHeights.length > 0) {
          const minH = Math.min(...rowHeights);
          const maxH = Math.max(...rowHeights);
          const curH = imageHeights[index];
          if (Math.abs(maxH - minH) >= 5) showBackground = curH < maxH - 5;
        }
      } else {
        const ar = item.width / item.height;
        showBackground = item.height > item.width && item.height > item.width * 3;
      }
      return (
        <PageItem
          page={item}
          itemW={itemW}
          cols={cols}
          metaColor={colors.metaText}
          onOpenPage={openPage}
          showBackground={showBackground}
        />
      );
    },
    [openPage, cols, itemW, colors.metaText, imageHeights]
  );

  const goRandomAgain = useCallback(async () => {
    if (rndLoading) return;
    try {
      setRndLoading(true);
      await initCdn();
      const randomId = await getRandomGalleryId();
      const g = await getGallery(randomId);
      const b = galleryToBook(g);
      router.replace({ pathname: "/book/[id]", params: { id: String(b.id), title: b.title.pretty, random: "1" } });
    } finally {
      setRndLoading(false);
    }
  }, [rndLoading, router]);

  if (!book) {
    return <LoadingSpinner fullScreen size="large" color={colors.accent} />;
  }

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.bg }}
      onLayout={(e) => {
        const newWidth = e.nativeEvent.layout.width;
        if (Math.abs(newWidth - listW) > 1) setListW(newWidth);
      }}
    >
      <FlatList
        ref={(ref) => {
          (listRef as any).current = ref;
          (fabListRef as any).current = ref;
        }}
        data={limitedPages}
        key={`book-${book?.id}-${cols}`}
        numColumns={cols}
        {...(Platform.OS !== "android" && {
          maintainVisibleContentPosition: { minIndexForVisible: 0, autoscrollToTopThreshold: null },
        })}
        keyExtractor={(p) => String(p.page)}
        renderItem={renderItem}
        onScroll={(e) => {
          onScrollFab(e);
          const y = e.nativeEvent.contentOffset.y;
          setScrollY(y);
          scrollPositionRef.current = y;
          offsetYRef.current = y;
          railRef.current?.syncToOffset(y);
        }}
        onContentSizeChange={(_, h) => {
          const prev = contentHRef.current;
          if (h > prev + 12 || h < prev - 12) {
            contentHRef.current = h;
            setContentH(h);
            railRef.current?.syncToOffset(offsetYRef.current);
          }
        }}
        onLayout={(e) => {
          const newWidth = e.nativeEvent.layout.width;
          const nextH = e.nativeEvent.layout.height;
          if (Math.abs(newWidth - listW) > 1) setListW(newWidth);
          if (Math.abs(nextH - viewportH) > 1) setViewportH(nextH);
        }}
        scrollEventThrottle={16}
        columnWrapperStyle={cols > 1 ? { alignItems: "stretch", paddingHorizontal: 0, justifyContent: "center" } : undefined}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: horizPad }}
        ListHeaderComponent={headerEl}
        ListFooterComponent={<>{showAllButton}{footerEl}</>}
        removeClippedSubviews={false}
        initialNumToRender={cols === 1 ? 10 : 24}
        maxToRenderPerBatch={cols === 1 ? 10 : 24}
        updateCellsBatchingPeriod={50}
        windowSize={11}
      />
      {Platform.OS !== "web" ? (
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

      {/* FAB */}
      <Animated.View style={[s.fab, { transform: [{ scale: fabScale }], opacity: fabScale }]}>
        <Pressable onPress={handleFabPress} style={[s.fabBtn, { backgroundColor: colors.accent }]}>
          <Ionicons name={scrollDirection === "down" ? "arrow-down" : "arrow-up"} size={24} color={colors.bg} />
        </Pressable>
      </Animated.View>

      {/* Random button */}
      {fromRandom && (
        <View style={[s.tryWrap, { bottom: 40 }]}>
          <View style={s.tryRounded}>
            <Pressable
              disabled={rndLoading}
              onPress={goRandomAgain}
              android_ripple={{ color: "#ffffff22", borderless: false }}
              style={({ pressed }) => [
                s.tryBtn,
                { backgroundColor: colors.accent },
                pressed && (Platform.select({ android: { opacity: 0.96, transform: [{ scale: 0.995 }] }, ios: { opacity: 0.85 } }) as any),
              ]}
            >
              {rndLoading ? (
                <LoadingSpinner size="small" color={colors.bg} />
              ) : (
                <>
                  <Feather name="shuffle" size={16} color={colors.bg} />
                  <Text style={[s.tryTxt, { color: colors.bg }]}>{t("book.fromRandomCta")}</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const FAB_SIZE = 48;
const s = StyleSheet.create({
  fab: { position: "absolute", right: 16, bottom: 36 },
  fabBtn: { width: FAB_SIZE, height: FAB_SIZE, borderRadius: FAB_SIZE / 2, justifyContent: "center", alignItems: "center", elevation: 4 },
  tryWrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  tryRounded: { borderRadius: 12, overflow: "hidden" },
  tryBtn: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, elevation: 4 },
  tryTxt: { fontSize: 14, fontWeight: "900", letterSpacing: 0.2 },
});
