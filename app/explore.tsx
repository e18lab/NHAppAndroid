import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FlatList, Platform, StyleSheet, View } from "react-native";

import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import type { Book } from "@/api/nhappApi/types";
import {
  imsearchMatchToBook,
  postImsearchSearchMultipart,
} from "@/api/nhappApi/imsearchClient";
import { fetchGalleryBrowseSlice } from "@/api/v2";
import { galleryCardToBook } from "@/api/v2/compat";
import BookList from "@/components/BookList";
import NoResultsPanel from "@/components/NoResultsPanel";
import PaginationBar from "@/components/PaginationBar";
import { INFINITE_SCROLL_KEY } from "@/components/settings/keys";
import { useDateRange } from "@/context/DateRangeContext";
import { usePageFilter } from "@/context/PageFilterContext";
import { useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useGridConfig } from "@/hooks/useGridConfig";
import { isBookBlacklisted, useBlacklistNameSet, useBlacklistSet } from "@/lib/blacklistFilter";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";
import { BROWSE_CARDS_PER_PAGE } from "@/utils/browseGridPageSize";
import {
  takeImsearchPendingFile,
  type ImsearchPendingFile,
} from "@/lib/imsearchPendingUpload";
import { scrollToTop } from "@/utils/scrollToTop";

const EXPLORE_CACHE = new Map<
  string,
  { books: Book[]; totalPages: number; totalItems: number }
>();

type ResultState = "idle" | "loading" | "no-results" | "timeout" | "error";

export default function ExploreScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useI18n();

  const { query: rawQ, solo: rawSolo, imsearch: rawImsearch, imt: rawImt } =
    useLocalSearchParams<{
      query?: string | string[];
      solo?: string | string[];
      imsearch?: string | string[];
      imt?: string | string[];
    }>();
  const urlQ = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  const solo = Array.isArray(rawSolo) ? rawSolo[0] : rawSolo;
  const imsearchParam = Array.isArray(rawImsearch) ? rawImsearch[0] : rawImsearch;
  const imsearchMode = imsearchParam === "1" || imsearchParam === "true";
  const imtParam = Array.isArray(rawImt) ? rawImt[0] : rawImt ?? "";

  const [query, setQuery] = useState(urlQ ?? "");
  const { sort, setSort } = useSort();
  const { pagesQuery } = usePageFilter();
  const {
    includes,
    excludes,
    clearAll: clearAllTagFilters,
  } = useFilterTags() as any;
  const { uploaded, clearUploaded, isHydrated } = useDateRange();
  const dateFilterActive = !!uploaded;

  const useFilters = solo !== "1";
  const activeIncludes = useFilters ? includes : [];
  const activeExcludes = useFilters ? excludes : [];
  const hasTagFilters =
    (activeIncludes?.length ?? 0) > 0 || (activeExcludes?.length ?? 0) > 0;

  const incStr = JSON.stringify(activeIncludes);
  const excStr = JSON.stringify(activeExcludes);

  const [books, setBooks] = useState<Book[]>([]);
  const blacklistIds = useBlacklistSet();
  const blacklistNames = useBlacklistNameSet();
  const [totalPages, setTotal] = useState(1);
  const [currentPage, setPage] = useState(1);
  const [favorites, setFav] = useState<Set<number>>(new Set());

  const [resultState, setResultState] = useState<ResultState>("idle");
  const [errorMsg, setErr] = useState<string>("");

  const [isPaginating, setPaginating] = useState(false);
  const [infiniteScroll, setInfiniteScroll] = useState(false);
  const scrollRef = useRef<FlatList<Book> | null>(null);
  const prevPageRef = useRef(currentPage);

  const reqIdRef = useRef(0);
  const skipPageChangeRef = useRef(false);
  const booksLengthRef = useRef(books.length);
  const gridConfig = useGridConfig();

  const imsearchFileRef = useRef<ImsearchPendingFile | null>(null);
  const [imsearchMissingFile, setImsearchMissingFile] = useState(false);

  const loadInfiniteScrollSetting = useCallback(() => {
    AsyncStorage.getItem(INFINITE_SCROLL_KEY).then((value) => {
      setInfiniteScroll(value === "true");
    });
  }, []);

  useEffect(() => {
    loadInfiniteScrollSetting();
    const unsub = subscribeToStorageApplied(loadInfiniteScrollSetting);
    return unsub;
  }, [loadInfiniteScrollSetting]);

  useFocusEffect(
    useCallback(() => {
      loadInfiniteScrollSetting();
    }, [loadInfiniteScrollSetting])
  );
 
  useEffect(() => {
    AsyncStorage.getItem("bookFavorites").then(
      (j) => j && setFav(new Set(JSON.parse(j)))
    );
  }, []);

  /** v: bump when browse API strategy changes (invalidates stale totalPages cache). */
  const cacheKey = useMemo(
    () =>
      JSON.stringify({
        v: 3,
        ipp: BROWSE_CARDS_PER_PAGE,
        q: [query.trim(), pagesQuery].filter(Boolean).join(" ").trim(),
        sort,
        inc: activeIncludes,
        exc: activeExcludes,
        page: currentPage,
        uploaded: uploaded ?? null,
        pages: pagesQuery,
      }),
    [query, sort, incStr, excStr, currentPage, uploaded, pagesQuery]
  );

  useEffect(() => {
    booksLengthRef.current = books.length;
  }, [books.length]);

  const fetchPage = useCallback(
    async (page: number, keyForCache: string, append = false) => {
      const q = [query.trim(), pagesQuery].filter(Boolean).join(" ").trim();
      const myReqId = ++reqIdRef.current;
      const isFirstLoad = booksLengthRef.current === 0;

      if (!append) {
        const cached = EXPLORE_CACHE.get(keyForCache);
        if (cached) {
          if (myReqId !== reqIdRef.current) return;
          setBooks(cached.books);
          setTotal(cached.totalPages);
          setResultState(cached.books.length ? "idle" : "no-results");
          setPaginating(false);
          return;
        }
      }

      setErr("");
      setResultState(isFirstLoad ? "loading" : "idle");

      let timeoutHit = false;
      const timer = setTimeout(() => {
        timeoutHit = true;
        if (isFirstLoad) setResultState("timeout");
      }, 15000);

      try {
        const ipp = BROWSE_CARDS_PER_PAGE;
        const offset = (page - 1) * ipp;
        const { slice, total: totalItems } = await fetchGalleryBrowseSlice(
          {
            query: q || "",
            includes: activeIncludes,
            excludes: activeExcludes,
            uploaded: uploaded ?? null,
            sort,
          },
          offset,
          ipp
        );
        const books = slice.map(galleryCardToBook);
        const uiTotalPages = Math.max(1, Math.ceil(totalItems / ipp));

        clearTimeout(timer);
        if (myReqId !== reqIdRef.current) return;

        if (append && page > 1) {
          setBooks((prev) => {
            const existingIds = new Set(prev.map((b: Book) => b.id));
            const newBooks = books.filter((b: Book) => !existingIds.has(b.id));
            return [...prev, ...newBooks];
          });
        } else {
          setBooks(books);
          if (page === 1 || !append) {
            EXPLORE_CACHE.set(keyForCache, {
              books,
              totalPages: uiTotalPages,
              totalItems,
            });
          }
        }
        setTotal(uiTotalPages);
        setResultState(books.length ? "idle" : "no-results");
      } catch (e: any) {
        clearTimeout(timer);
        if (myReqId !== reqIdRef.current) return;
        setErr(e?.message || String(e));
        setResultState(timeoutHit ? "timeout" : "error");
      } finally {
        setPaginating(false);
      }
    },
    [
      query,
      sort,
      incStr,
      excStr,
      uploaded,
      activeIncludes,
      activeExcludes,
      infiniteScroll,
      pagesQuery,
    ]
  );

  const loadImsearchResults = useCallback(async () => {
    const pending = imsearchFileRef.current;
    if (!pending) {
      setBooks([]);
      setTotal(1);
      setPage(1);
      setResultState("no-results");
      return;
    }
    setErr("");
    setResultState("loading");
    try {
      const file =
        pending.kind === "web"
          ? pending.file
          : { uri: pending.uri, name: pending.name, type: pending.type };
      const result = await postImsearchSearchMultipart(file);
      const valid = (result.matches || [])
        .filter((m) => /^\d+$/.test(String(m.galleryId || "").trim()))
        .map((m) => ({
          m,
          idNum: parseInt(String(m.galleryId).trim(), 10),
        }))
        .sort((a, b) => (Number(b.m.score) || 0) - (Number(a.m.score) || 0))
        .map(({ m, idNum }) => imsearchMatchToBook(m, idNum));
      setBooks(valid);
      setTotal(1);
      setPage(1);
      setResultState(valid.length ? "idle" : "no-results");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBooks([]);
      setTotal(1);
      setPage(1);
      setResultState("error");
    }
  }, []);

  useEffect(() => {
    if (!imsearchMode) {
      imsearchFileRef.current = null;
      setImsearchMissingFile(false);
    }
  }, [imsearchMode]);

  useEffect(() => {
    if (!isHydrated || !imsearchMode) return;
    imsearchFileRef.current = takeImsearchPendingFile();
    if (!imsearchFileRef.current) {
      setImsearchMissingFile(true);
      setBooks([]);
      setTotal(1);
      setPage(1);
      setResultState("no-results");
      return;
    }
    setImsearchMissingFile(false);
    void loadImsearchResults();
  }, [isHydrated, imsearchMode, imtParam, loadImsearchResults]);

  useEffect(() => {
    if (!isHydrated || imsearchMode) return;
    if (skipPageChangeRef.current) {
      skipPageChangeRef.current = false;
      return;
    }
    fetchPage(currentPage, cacheKey, false);
  }, [isHydrated, imsearchMode, cacheKey, currentPage, fetchPage]);

  useEffect(() => {
    setQuery(urlQ ?? "");
  }, [urlQ]);

  useEffect(() => {
    setPage(1);
    scrollToTop(scrollRef);
  }, [query, sort, incStr, excStr, uploaded, pagesQuery]);

  useEffect(() => {
    if (totalPages < 1) return;
    if (currentPage > totalPages) setPage(totalPages);
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (prevPageRef.current === currentPage) return;
    prevPageRef.current = currentPage;
    if (infiniteScroll) return;
    if (Platform.OS === "web") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToTop(scrollRef));
      });
    } else {
      scrollToTop(scrollRef);
    }
  }, [currentPage, infiniteScroll]);

  const onRefresh = useCallback(async () => {
    if (!isHydrated) return;
    if (imsearchMode) {
      await loadImsearchResults();
      return;
    }
    await fetchPage(currentPage, cacheKey);
  }, [isHydrated, imsearchMode, currentPage, cacheKey, fetchPage, loadImsearchResults]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handleRefresh = async () => {
      globalThis.dispatchEvent?.(
        new globalThis.CustomEvent("app:refresh-content-start")
      );
      try {
        await onRefresh();
      } finally {
        globalThis.dispatchEvent?.(
          new globalThis.CustomEvent("app:refresh-content-end")
        );
      }
    };
    globalThis.addEventListener?.("app:refresh-content", handleRefresh);
    return () => {
      globalThis.removeEventListener?.("app:refresh-content", handleRefresh);
    };
  }, [onRefresh]);

  const toggleFav = useCallback(
    (id: number, next: boolean) => {
      setFav((prev) => {
        const cp = new Set(prev);
        next ? cp.add(id) : cp.delete(id);
        AsyncStorage.setItem("bookFavorites", JSON.stringify([...cp]));
        requestStoragePush();
        return cp;
      });

      setBooks((prev) => {
        const patched = prev.map((b) =>
          b.id === id
            ? {
                ...b,
                favorites: Math.max(
                  0,
                  (typeof b.favorites === "number" ? b.favorites : 0) +
                    (next ? 1 : -1)
                ),
              }
            : b
        );
        const cached = !imsearchMode ? EXPLORE_CACHE.get(cacheKey) : undefined;
        if (cached)
          EXPLORE_CACHE.set(cacheKey, {
            books: patched,
            totalPages: cached.totalPages,
            totalItems: cached.totalItems,
          });
        return patched;
      });
    },
    [cacheKey, imsearchMode]
  );

  const showNoResults =
    resultState === "no-results" ||
    (imsearchMode && resultState === "error" && books.length === 0);
  const strictBlacklistMode = imsearchMode || query.trim().length > 0;
  const visibleBooks = useMemo(
    () =>
      strictBlacklistMode && (blacklistIds.size || blacklistNames.size)
        ? books.filter((b) => !isBookBlacklisted(b, blacklistIds, blacklistNames))
        : books,
    [blacklistIds, blacklistNames, books, strictBlacklistMode]
  );
  const showNoResultsWithBlacklist =
    showNoResults ||
    (strictBlacklistMode &&
      resultState !== "loading" &&
      resultState !== "error" &&
      visibleBooks.length === 0);

  const reason = dateFilterActive ? "dates" : hasTagFilters ? "filters" : "general";

  const noResPanelTitle = useMemo(() => {
    if (imsearchMode) {
      if (resultState === "error") return t("toast.errorTitle");
      if (imsearchMissingFile) return t("search.imageSearchNoPayload");
      return t("search.imageSearchNoMatches");
    }
    if (reason === "dates")
      return (
        t("explore.noResults.title.dates") ||
        "В выбранном диапазоне дат ничего не найдено"
      );
    if (reason === "filters")
      return (
        t("explore.noResults.title.filters") ||
        "По выбранным фильтрам ничего не найдено"
      );
    if (query.trim())
      return (
        (t("explore.noResults.title.query", {
          query: query.trim(),
        }) as string) || `По запросу «${query.trim()}» ничего не найдено`
      );
    return t("explore.noResults.title.default") || "Ничего не найдено";
  }, [
    imsearchMode,
    resultState,
    imsearchMissingFile,
    reason,
    query,
    t,
  ]);

  const noResSubtitleBase =
    t("explore.noResults.subtitle") ||
    "Попробуй изменить запрос, снять часть фильтров или расширить диапазон.";

  const noResPanelSubtitle = useMemo(
    () =>
      imsearchMode && resultState === "error"
        ? errorMsg || t("toast.genericFailure")
        : noResSubtitleBase,
    [imsearchMode, resultState, errorMsg, noResSubtitleBase, t]
  );

  const noResActions = useMemo(() => {
    if (imsearchMode) {
      return [
        {
          label: t("search.imageSearchPickOther"),
          onPress: () => router.push("/search"),
        },
        {
          label: t("searchBar.backHome"),
          onPress: () => router.replace("/"),
        },
      ];
    }
    const base = [
      {
        label: t("explore.noResults.actions.openFilters") || "Открыть фильтры",
        onPress: () => router.push("/tags"),
      },
      {
        label: t("explore.noResults.actions.fresh") || "Свежие",
        onPress: () => setSort("date"),
      },
      {
        label:
          t("explore.noResults.actions.popularMonth") || "Популярное за месяц",
        onPress: () => setSort("popular-month"),
      },
    ];
    if (reason === "dates")
      return [
        {
          label: t("explore.noResults.actions.resetDates") || "Сбросить даты",
          onPress: clearUploaded,
        },
        ...base,
      ];
    if (reason === "filters") {
      return [
        {
          label:
            t("explore.noResults.actions.resetFilters") || "Сбросить фильтры",
          onPress: () => {
            clearAllTagFilters?.() ?? router.push("/tags");
          },
        },
        ...base,
      ];
    }
    return [
      {
        label: t("explore.noResults.actions.changeQuery") || "Изменить запрос",
        onPress: () =>
          router.push({
            pathname: "/search",
            params: { query: query.trim() },
          }),
      },
      ...base,
    ];
  }, [
    router,
    query,
    setSort,
    clearUploaded,
    reason,
    clearAllTagFilters,
    t,
    imsearchMode,
  ]);

  const showListSkeleton =
    resultState === "loading" && visibleBooks.length === 0;

  return (
    <View style={styles.container}>
      {showNoResultsWithBlacklist && (
        <NoResultsPanel
          title={noResPanelTitle}
          subtitle={noResPanelSubtitle}
          iconName={
            imsearchMode
              ? "image"
              : reason === "dates"
              ? "calendar"
              : reason === "filters"
              ? "filter"
              : "search"
          }
          actions={noResActions}
        />
      )}

      {!showNoResultsWithBlacklist && (
        <>
          <BookList
            data={visibleBooks}
            loading={showListSkeleton}
            refreshing={false}
            onRefresh={onRefresh}
            isFavorite={(id) => favorites.has(id)}
            onToggleFavorite={toggleFav}
            onPress={(id) => {
              const b = visibleBooks.find((x) => x.id === id);
              router.push({
                pathname: "/book/[id]",
                params: {
                  id: String(id),
                  title: b?.title?.pretty ?? "",
                },
              });
            }}
            gridConfig={{ default: gridConfig }}
            scrollRef={scrollRef}
            onEndReached={
              !imsearchMode &&
              infiniteScroll &&
              currentPage < totalPages &&
              !isPaginating
                ? () => {
                    setPaginating(true);
                    const nextPage = currentPage + 1;
                    const nextCacheKey = JSON.stringify({
                      v: 3,
                      ipp: BROWSE_CARDS_PER_PAGE,
                      q: [query.trim(), pagesQuery].filter(Boolean).join(" ").trim(),
                      sort,
                      inc: activeIncludes,
                      exc: activeExcludes,
                      page: nextPage,
                      uploaded: uploaded ?? null,
                      pages: pagesQuery,
                    });
                    skipPageChangeRef.current = true;
                    fetchPage(nextPage, nextCacheKey, true);
                    setPage(nextPage);
                  }
                : undefined
            }
          />
          {!imsearchMode && !infiniteScroll && (
            <PaginationBar
              currentPage={currentPage}
              totalPages={totalPages}
              onChange={(p) => {
                setPaginating(true);
                skipPageChangeRef.current = true;
                const paginationCacheKey = JSON.stringify({
                  v: 3,
                  ipp: BROWSE_CARDS_PER_PAGE,
                  q: [query.trim(), pagesQuery].filter(Boolean).join(" ").trim(),
                  sort,
                  inc: activeIncludes,
                  exc: activeExcludes,
                  page: p,
                  uploaded: uploaded ?? null,
                  pages: pagesQuery,
                });
                fetchPage(p, paginationCacheKey, false);
                setPage(p);
              }}
              scrollRef={scrollRef}
              hideWhenInfiniteScroll={false}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
