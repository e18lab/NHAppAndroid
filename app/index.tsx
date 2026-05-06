import type { Book } from "@/api/nhappApi/types";
import { fetchGalleryBrowseSlice } from "@/api/v2";
import { galleryCardToBook } from "@/api/v2/compat";
import BookList from "@/components/BookList";
import NoResultsPanel from "@/components/NoResultsPanel";
import PaginationBar from "@/components/PaginationBar";
import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import { INFINITE_SCROLL_KEY } from "@/components/settings/keys";
import { useDateRange } from "@/context/DateRangeContext";
import { usePageFilter } from "@/context/PageFilterContext";
import { useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useGridConfig } from "@/hooks/useGridConfig";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useI18n } from "@/lib/i18n/I18nContext";
import { getBannerAssetDataUrls, isElectron } from "@/electron/bridge";
import { useTheme, type ThemeColors } from "@/lib/ThemeContext";
import { BROWSE_CARDS_PER_PAGE } from "@/utils/browseGridPageSize";
import { scrollToTop } from "@/utils/scrollToTop";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setPendingWhatsNew } from "@/store/pendingWhatsNew";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  FlatList,
  Image,
  ImageBackground,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";


type CacheEntry = {
  books: Book[];
  totalPages: number;
  totalItems: number;
  ts: number;
};
const EXPLORE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

const UPDATE_BANNER_BG = require("@/assets/images/upd.png");
const UPDATE_BANNER_ICON = require("@/assets/images/adaptive-icon.png");

type ResultState = "idle" | "loading" | "no-results" | "timeout" | "error";

export default function HomeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { query: rawQ, solo: rawSolo } = useLocalSearchParams<{
    query?: string | string[];
    solo?: string | string[];
  }>();
  const urlQ = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  const solo = Array.isArray(rawSolo) ? rawSolo[0] : rawSolo;
  const { t } = useI18n();

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
  const [totalPages, setTotal] = useState(1);
  const [currentPage, setPage] = useState(1);
  const [favorites, setFav] = useState<Set<number>>(new Set());

  const [resultState, setResultState] = useState<ResultState>("idle");
  const [errorMsg, setErr] = useState<string>("");

  const [isPaginating, setPaginating] = useState(false);
  const [infiniteScroll, setInfiniteScroll] = useState(false);
  const scrollRef = useRef<FlatList<Book> | null>(null);
  const prevPageRef = useRef(currentPage);

  const gridConfig = useGridConfig();
  const reqIdRef = useRef(0);
  const skipPageChangeRef = useRef(false);
  const booksLengthRef = useRef(books.length);

  const { update, checkUpdate } = useUpdateCheck();

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
    async (page: number, keyForCache: string, force = false, swr = false, append = false) => {
      const q = [query.trim(), pagesQuery].filter(Boolean).join(" ").trim();
      const myReqId = ++reqIdRef.current;
      const isFirstLoad = booksLengthRef.current === 0;

      if (!force && !append) {
        const cached = EXPLORE_CACHE.get(keyForCache);
        const freshEnough =
          cached &&
          (page !== 1 || sort !== "date"
            ? true
            : Date.now() - cached.ts < CACHE_TTL_MS);

        if (cached && (freshEnough || swr)) {
          setBooks(cached.books);
          setTotal(cached.totalPages);
          setResultState(cached.books.length ? "idle" : "no-results");
          if (!swr && freshEnough) {
            setPaginating(false);
            return;
          }
        }
      }

      setErr("");
      if (isFirstLoad && !swr) {
        setResultState("loading");
      }

      let timeoutHit = false;
      const timer = setTimeout(() => {
        timeoutHit = true;
        if (isFirstLoad || swr) setResultState("timeout");
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
              ts: Date.now(),
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

  useEffect(() => {
    if (!isHydrated) return;
    if (skipPageChangeRef.current) {
      skipPageChangeRef.current = false;
      return;
    }
    const wantFresh = currentPage === 1 && sort === "date";
    fetchPage(currentPage, cacheKey, wantFresh, wantFresh, false);
  }, [isHydrated, cacheKey, currentPage, sort, fetchPage]);

  useEffect(() => setQuery(urlQ ?? ""), [urlQ]);
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
    await fetchPage(currentPage, cacheKey, true, false);
    checkUpdate();
  }, [isHydrated, currentPage, cacheKey, fetchPage, checkUpdate]);

  useFocusEffect(
    useCallback(() => {
      // Auto-refresh while this screen is focused and the app is active.
      // Should work on phone + Electron + web.
      if (!isHydrated) return;
      if (isPaginating) return;

      let cancelled = false;
      let inFlight = false;
      let appState: "active" | "background" | "inactive" =
        (AppState.currentState as any) ?? "active";
      let webVisible = true;
      if (Platform.OS === "web") {
        try {
          webVisible = !(globalThis as any).document?.hidden;
        } catch {
          webVisible = true;
        }
      }

      const intervalMs = 75_000;

      const tick = async () => {
        if (cancelled || inFlight) return;
        if (Platform.OS === "web") {
          if (!webVisible) return;
        } else if (appState !== "active") {
          return;
        }
        // If user is not on the first page or not sorted by date, avoid background polling.
        if (currentPage !== 1 || sort !== "date") return;

        inFlight = true;
        try {
          await onRefresh();
        } finally {
          inFlight = false;
        }
      };

      const sub =
        Platform.OS === "web"
          ? null
          : AppState.addEventListener("change", (next) => {
              appState = next as any;
              if (next === "active") void tick();
            });

      const onVisibility = () => {
        try {
          webVisible = !(globalThis as any).document?.hidden;
        } catch {
          webVisible = true;
        }
        if (webVisible) void tick();
      };
      const onWindowFocus = () => void tick();

      if (Platform.OS === "web") {
        try {
          (globalThis as any).document?.addEventListener?.(
            "visibilitychange",
            onVisibility
          );
          (globalThis as any).addEventListener?.("focus", onWindowFocus);
        } catch {
          // ignore
        }
      }

      const t0 = setTimeout(() => void tick(), 5_000);
      const id = setInterval(() => void tick(), intervalMs);
      return () => {
        cancelled = true;
        clearTimeout(t0);
        clearInterval(id);
        if (Platform.OS === "web") {
          try {
            (globalThis as any).document?.removeEventListener?.(
              "visibilitychange",
              onVisibility
            );
            (globalThis as any).removeEventListener?.("focus", onWindowFocus);
          } catch {
            // ignore
          }
        } else {
          sub?.remove();
        }
      };
    }, [isHydrated, isPaginating, currentPage, sort, onRefresh])
  );

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
        const cached = EXPLORE_CACHE.get(cacheKey);
        if (cached)
          EXPLORE_CACHE.set(cacheKey, {
            books: patched,
            totalPages: cached.totalPages,
            totalItems: cached.totalItems,
            ts: cached.ts,
          });
        return patched;
      });
    },
    [cacheKey]
  );

  const showNoResults = resultState === "no-results";

  const reason = dateFilterActive ? "dates" : hasTagFilters ? "filters" : "general";

  const noResTitle =
    reason === "dates"
      ? t("explore.noResults.title.dates")
      : reason === "filters"
      ? t("explore.noResults.title.filters")
      : query.trim()
      ? t("explore.noResults.title.query", { query: query.trim() })
      : t("explore.noResults.title.general");

  const noResSubtitle = t("explore.noResults.subtitle");

  const noResActions = useMemo(() => {
    const base = [
      {
        label: t("explore.noResults.actions.openFilters"),
        onPress: () => router.push("/tags"),
      },
      {
        label: t("explore.noResults.actions.fresh"),
        onPress: () => setSort("date"),
      },
      {
        label: t("explore.noResults.actions.popularMonth"),
        onPress: () => setSort("popular-month"),
      },
    ];
    if (reason === "dates")
      return [
        {
          label: t("explore.noResults.actions.resetDates"),
          onPress: clearUploaded,
        },
        ...base,
      ];
    if (reason === "filters") {
      return [
        {
          label: t("explore.noResults.actions.resetFilters"),
          onPress: () => {
            clearAllTagFilters?.() ?? router.push("/tags");
          },
        },
        ...base,
      ];
    }
    return [
      {
        label: t("explore.noResults.actions.changeQuery"),
        onPress: () =>
          router.push({
            pathname: "/search",
            params: { query: query.trim() },
          }),
      },
      ...base,
    ];
  }, [router, query, setSort, clearUploaded, reason, clearAllTagFilters, t]);

  const showListSkeleton =
    resultState === "loading" && books.length === 0;

  return (
    <View style={styles.container}>
      <UpdateBanner
        update={update}
        colors={colors}
        t={t}
        onOpenWhatsNewPage={() => {
          if (update) {
            setPendingWhatsNew(update);
            router.push("/whats-new");
          }
        }}
      />

      {showNoResults && (
        <NoResultsPanel
          title={noResTitle}
          subtitle={noResSubtitle}
          iconName={
            reason === "dates"
              ? "calendar"
              : reason === "filters"
              ? "filter"
              : "search"
          }
          actions={noResActions}
        />
      )}

      {!showNoResults && (
        <>
          <BookList
            data={books}
            loading={showListSkeleton}
            refreshing={false}
            onRefresh={onRefresh}
            isFavorite={(id) => favorites.has(id)}
            onToggleFavorite={toggleFav}
            onPress={(id) => {
              const b = books.find((x) => x.id === id);
              router.push({
                pathname: "/book/[id]",
                params: { id: String(id), title: b?.title?.pretty ?? "" },
              });
            }}
            gridConfig={{ default: gridConfig }}
            scrollRef={scrollRef}
            onEndReached={
              infiniteScroll && currentPage < totalPages && !isPaginating
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
                    fetchPage(nextPage, nextCacheKey, false, false, true);
                    setPage(nextPage);
                  }
                : undefined
            }
          />
          {!infiniteScroll && (
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
                fetchPage(p, paginationCacheKey, false, false, false);
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
  ctaBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  updateBannerOuter: {
    overflow: "hidden",
    position: "relative",
    alignSelf: "stretch",
  },
  updateBannerBgImage: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    backfaceVisibility: "hidden",
  },
  updateBannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.52)",
  },
  updateBannerPlankBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  updateBannerInnerWrap: {
    position: "relative",
    zIndex: 1,
  },
  updateBannerInnerWrapCentered: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 860,
  },
  updateBannerInner: {
    flexDirection: "row",
    alignItems: "center",
  },
  updateAppIcon: {
    overflow: "hidden",
  },
  updateTextBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  updateTitle: {
    fontWeight: "700",
  },
  updateWhatsNew: {
    fontSize: 13,
    textDecorationLine: "underline",
    opacity: 0.95,
  },
  updateCtaBtn: {
    borderWidth: 1.5,
  },
  updateCtaText: {
    fontWeight: "700",
    fontSize: 14,
  },
  updatePlankTitle: {
    color: "#fff",
  },
  updatePlankLink: {
    color: "rgba(255,255,255,0.82)",
    marginTop: 2,
  },
  updatePlankCta: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderColor: "rgba(255,255,255,0.28)",
    borderWidth: 1,
  },
  updatePlankCtaText: {
    color: "#fff",
  },
});

type UpdateBannerLayout = {
  layoutWidth: number;
  isWide: boolean;
  isDesktop: boolean;
  padH: number;
  iconSize: number;
};

function UpdateBanner(props: {
  update: { versionName: string; notes: string; apkUrl: string } | null;
  colors: ThemeColors;
  t: (key: string) => string;
  onOpenWhatsNewPage: () => void;
}) {
  const { update, colors, t, onOpenWhatsNewPage } = props;
  const { width } = useWindowDimensions();
  const [electronAssets, setElectronAssets] = useState<{
    bg: string | null;
    icon: string | null;
  }>({ bg: null, icon: null });
  useEffect(() => {
    if (Platform.OS !== "web" || !isElectron()) return;
    getBannerAssetDataUrls().then(setElectronAssets);
  }, []);
  const layout = useMemo(() => {
    const isWide = width >= 520;
    const isDesktop = width >= 900;
    return {
      layoutWidth: width,
      isWide,
      isDesktop,
      padH: isWide ? 20 : 14,
      iconSize: isWide ? 48 : 40,
    };
  }, [width]);
  if (!update) return null;
  return (
    <UpdateBannerContent
      layout={layout}
      update={update}
      colors={colors}
      t={t}
      onOpenWhatsNewPage={onOpenWhatsNewPage}
      bannerWidth={Platform.OS === "web" ? width : "100%"}
      alignSelfCenter={Platform.OS === "web"}
      electronBgUri={electronAssets.bg}
      electronIconUri={electronAssets.icon}
    />
  );
}

const UpdateBannerContent = React.memo(function UpdateBannerContent(props: {
  layout: UpdateBannerLayout;
  update: { versionName: string; notes: string; apkUrl: string };
  colors: ThemeColors;
  t: (key: string) => string;
  onOpenWhatsNewPage: () => void;
  bannerWidth: number | "100%";
  alignSelfCenter: boolean;
  electronBgUri: string | null;
  electronIconUri: string | null;
}) {
  const { layout, update, colors, t, onOpenWhatsNewPage, bannerWidth, alignSelfCenter, electronBgUri, electronIconUri } = props;
  const { padH, iconSize, isWide, isDesktop } = layout;
  const bgSource = electronBgUri ? { uri: electronBgUri } : UPDATE_BANNER_BG;
  const iconSource = electronIconUri ? { uri: electronIconUri } : UPDATE_BANNER_ICON;
  return (
    <View
      style={[
        styles.updateBannerOuter,
        styles.updateBannerPlankBorder,
        {
          width: bannerWidth,
          ...(alignSelfCenter && { alignSelf: "center" as const }),
        },
      ]}
    >
      <ImageBackground
        source={bgSource}
        style={styles.updateBannerBgImage}
        resizeMode="cover"
      >
        <View style={styles.updateBannerOverlay} />
      </ImageBackground>
      <View
        style={[
          styles.updateBannerInnerWrap,
          isDesktop && styles.updateBannerInnerWrapCentered,
        ]}
      >
        <View
          style={[
            styles.updateBannerInner,
            {
              paddingHorizontal: padH,
              paddingVertical: isWide ? 14 : 12,
              gap: isWide ? 14 : 10,
              maxWidth: isDesktop ? 860 : undefined,
            },
          ]}
        >
          <Image
            source={iconSource}
            style={[
              styles.updateAppIcon,
              { width: iconSize, height: iconSize, borderRadius: iconSize / 4 },
            ]}
            resizeMode="cover"
          />
          <View style={styles.updateTextBlock}>
            <Text
              style={[
                styles.updateTitle,
                styles.updatePlankTitle,
                { fontSize: isWide ? 17 : 15 },
              ]}
              numberOfLines={1}
            >
              {t("NewUpdate")} {update.versionName}
            </Text>
            <TouchableOpacity onPress={onOpenWhatsNewPage} activeOpacity={0.7}>
              <Text
                style={[styles.updateWhatsNew, styles.updatePlankLink]}
                numberOfLines={1}
              >
                {t("whatsNewUpdate")}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={() =>
              Linking.openURL(
                "https://github.com/e18lab/NHAppAndroid/releases/latest"
              )
            }
            activeOpacity={0.8}
            style={[
              styles.updateCtaBtn,
              styles.updatePlankCta,
              {
                paddingVertical: isWide ? 10 : 8,
                paddingHorizontal: isWide ? 18 : 14,
                borderRadius: isWide ? 12 : 10,
              },
            ]}
          >
            <Text style={[styles.updateCtaText, styles.updatePlankCtaText]}>
              {t("downloadUpdate")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
});
