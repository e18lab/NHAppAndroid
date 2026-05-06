import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import {
    Alert,
    FlatList,
    ListRenderItem,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    useWindowDimensions,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import LoadingSpinner from "./LoadingSpinner";

import type { Book } from "@/api/nhappApi/types";
import { fetchBooksFromRecommendationLib } from "@/api/nhappApi/recommendationLib";
import { addFavorite, removeFavorite } from "@/api/v2";
import {
  addOnlineFavoriteIds,
  removeOnlineFavoriteIds,
} from "@/lib/onlineFavoritesStorage";
import { bulkAddFavoritesV2 } from "@/lib/onlineFavoritesBulk";

async function onlineBulkUnfavorite(
  ids: number[],
  onProgress?: (done: number, total: number) => void
): Promise<{ failed: number[] }> {
  const failed: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    try { await removeFavorite(ids[i]); } catch { failed.push(ids[i]); }
    onProgress?.(i + 1, ids.length);
    await new Promise((r) => setTimeout(r, 120));
  }
  return { failed };
}

const onlineFavorite = (id: number) => addFavorite(id);
const onlineUnfavorite = (id: number) => removeFavorite(id);
import BookCard from "@/components/BookCard";
import { CardPressable } from "@/components/ui/CardPressable";
import { useAutoImport } from "@/context/AutoImportProvider";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";
import FastScrollRail, { type FastScrollRailHandle } from "./FastScrollRail";

export interface GridConfig {
  numColumns: number;
  minColumnWidth?: number;
  paddingHorizontal?: number;
  columnGap?: number;
}
type BreakpointConfig = {
  phonePortrait?: GridConfig;
  phoneLandscape?: GridConfig;
  tabletPortrait?: GridConfig;
  tabletLandscape?: GridConfig;
  default?: GridConfig;
};

type Props = {
  data: Book[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onEndReached?: () => void;
  onPress?: (id: number) => void;

  gridConfig?: BreakpointConfig;
  ListEmptyComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactElement | null;
  ListHeaderComponent?: React.ReactElement | null;
  hideToolbar?: boolean;

  background?: string;

  onAfterUnfavorite?: (removedIds: number[]) => void;
  onRestoreFavorites?: (books: Book[]) => void;
  scrollRef?: React.RefObject<FlatList<Book>>;
};

export default function BookListOnline({
  data,
  loading,
  refreshing,
  onRefresh,
  onEndReached,
  onPress,
  gridConfig,
  ListEmptyComponent,
  ListFooterComponent,
  ListHeaderComponent,
  hideToolbar = false,
  background,
  onAfterUnfavorite,
  onRestoreFavorites,
  scrollRef,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { t } = useI18n();

  const {
    enabled: autoImportEnabled,
    setEnabled: setAutoImportEnabled,
    isRunning,
  } = useAutoImport();

  const [items, setItems] = React.useState<Book[]>(data);
  React.useEffect(() => setItems(data), [data]);

  // Enrich cards (tags/artists/pages/uploaded) via recommendation-lib so "Collecting info" resolves.
  const [enrichedById, setEnrichedById] = React.useState<Record<number, Book>>({});
  const enrichQueuedRef = React.useRef<Set<number>>(new Set());
  const enrichInFlightRef = React.useRef<Set<number>>(new Set());
  const enrichTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const mergeEnriched = React.useCallback((base: Book, enriched?: Book): Book => {
    if (!enriched) return base;
    const b: any = base as any;
    const e: any = enriched as any;
    const pickStr = (a?: string, bb?: string) => (a && String(a).trim() ? a : bb || "");
    const pickNum = (a?: number, bb?: number) =>
      typeof a === "number" && Number.isFinite(a) && a > 0 ? a : (bb as any);
    return {
      ...b,
      title: {
        english: pickStr(e?.title?.english, b?.title?.english),
        japanese: pickStr(e?.title?.japanese, b?.title?.japanese),
        pretty: pickStr(e?.title?.pretty, b?.title?.pretty),
      },
      uploaded: pickStr(e?.uploaded, b?.uploaded),
      pagesCount: pickNum(e?.pagesCount, b?.pagesCount) ?? b?.pagesCount,
      tags: Array.isArray(e?.tags) && e.tags.length ? e.tags : b?.tags,
      artists: Array.isArray(e?.artists) && e.artists.length ? e.artists : b?.artists,
      characters:
        Array.isArray(e?.characters) && e.characters.length ? e.characters : b?.characters,
      parodies: Array.isArray(e?.parodies) && e.parodies.length ? e.parodies : b?.parodies,
      groups: Array.isArray(e?.groups) && e.groups.length ? e.groups : b?.groups,
      categories:
        Array.isArray(e?.categories) && e.categories.length ? e.categories : b?.categories,
      languages:
        Array.isArray(e?.languages) && e.languages.length ? e.languages : b?.languages,
      tagIds: Array.isArray(e?.tagIds) && e.tagIds.length ? e.tagIds : b?.tagIds,
      // keep cover/thumbnail from base to avoid flicker
      cover: pickStr(b?.cover, e?.cover),
      thumbnail: pickStr(b?.thumbnail, e?.thumbnail),
      coverW: pickNum(b?.coverW, e?.coverW) ?? b?.coverW,
      coverH: pickNum(b?.coverH, e?.coverH) ?? b?.coverH,
      media: pickNum(b?.media, e?.media) ?? b?.media,
    } as Book;
  }, []);

  const flushEnrichQueue = React.useCallback(() => {
    if (enrichTimerRef.current) {
      clearTimeout(enrichTimerRef.current);
      enrichTimerRef.current = null;
    }
    const ids = Array.from(enrichQueuedRef.current);
    enrichQueuedRef.current.clear();
    if (!ids.length) return;
    ids.forEach((id) => enrichInFlightRef.current.add(id));
    void (async () => {
      try {
        const enriched = await fetchBooksFromRecommendationLib(ids, {
          placeholdersForMissing: true,
        });
        const next: Record<number, Book> = {};
        for (const b of enriched) next[b.id] = b;
        setEnrichedById((prev) => ({ ...prev, ...next }));
      } catch {
        // ignore (offline)
      } finally {
        ids.forEach((id) => enrichInFlightRef.current.delete(id));
      }
    })();
  }, []);

  const requestEnrich = React.useCallback(
    (id: number) => {
      if (!Number.isFinite(id) || id <= 0) return;
      if (enrichedById[id]) return;
      if (enrichInFlightRef.current.has(id)) return;
      enrichQueuedRef.current.add(id);
      if (!enrichTimerRef.current) {
        enrichTimerRef.current = setTimeout(flushEnrichQueue, 250);
      }
    },
    [enrichedById, flushEnrichQueue]
  );

  React.useEffect(() => {
    return () => {
      if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
      enrichTimerRef.current = null;
      enrichQueuedRef.current.clear();
      enrichInFlightRef.current.clear();
    };
  }, []);

  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const clearSelect = () => setSelected(new Set());

  const [undoStack, setUndoStack] = React.useState<Book[]>([]);
  const pushUndo = (books: Book[]) =>
    setUndoStack((prev) => [...books, ...prev]);
  const clearUndo = () => setUndoStack([]);

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    const toRestore = [...undoStack];
    const ids = toRestore.map((b) => b.id);
    try {
      if (ids.length === 1) {
        await onlineFavorite(ids[0]);
        await addOnlineFavoriteIds(ids);
      } else {
        const { failed } = await bulkAddFavoritesV2(ids);
        const ok = ids.filter((id) => !failed.includes(id));
        await addOnlineFavoriteIds(ok);
      }
    } catch {}
    setItems((prev) => {
      const exist = new Set(prev.map((b) => b.id));
      const restored = toRestore.filter((b) => !exist.has(b.id));
      return restored.concat(prev);
    });
    onRestoreFavorites?.(toRestore);
    clearUndo();
  };

  const themeBg =
    background ??
    (colors as any).page ??
    (colors as any).surfaceElevated ??
    (colors as any).bg ??
    "#1C1C1C";

  const baseConfig = React.useMemo<GridConfig>(() => {
    const isPortrait = height > width;
    const isTablet = width >= 768;

    const pick =
      (isTablet
        ? isPortrait
          ? gridConfig?.tabletPortrait
          : gridConfig?.tabletLandscape
        : isPortrait
        ? gridConfig?.phonePortrait
        : gridConfig?.phoneLandscape) ?? gridConfig?.default;

    const defaultsPhone: GridConfig = {
      numColumns: isPortrait ? 2 : 3,
      minColumnWidth: 128,
      paddingHorizontal: 12,
      columnGap: 10,
    };
    const defaultsTablet: GridConfig = {
      numColumns: isPortrait ? 4 : 5,
      minColumnWidth: 150,
      paddingHorizontal: 14,
      columnGap: 12,
    };
    const def = isTablet ? defaultsTablet : defaultsPhone;

    return {
      numColumns: Math.max(1, pick?.numColumns ?? def.numColumns!),
      minColumnWidth: pick?.minColumnWidth ?? def.minColumnWidth,
      paddingHorizontal: pick?.paddingHorizontal ?? def.paddingHorizontal,
      columnGap: pick?.columnGap ?? def.columnGap,
    };
  }, [width, height, gridConfig]);

  const { cols, cardWidth, columnGap, paddingHorizontal } = React.useMemo(() => {
    const padH = baseConfig.paddingHorizontal ?? 0;
    const gap = baseConfig.columnGap ?? 0;
    const minW = baseConfig.minColumnWidth ?? 120;
    const avail = Math.max(0, width - padH * 2);
    const maxByWidth = Math.max(1, Math.floor((avail + gap) / (minW + gap)));
    const cols = Math.min(maxByWidth, baseConfig.numColumns);
    const cw = cols > 0 ? (avail - gap * (cols - 1)) / cols : avail;

    return {
      cols,
      cardWidth: cw,
      columnGap: gap,
      paddingHorizontal: padH,
    };
  }, [baseConfig, width]);

  const isSingleCol = cols === 1;
  const contentScale = isSingleCol ? 0.45 : 0.65;

  const removeIdsLocally = (ids: number[]) =>
    setItems((prev) => prev.filter((b) => !ids.includes(b.id)));

  const runMassDelete = async (ids: number[]) => {
    if (!ids.length) return;
    const removed = items.filter((b) => ids.includes(b.id));
    removeIdsLocally(ids);
    onAfterUnfavorite?.(ids);
    pushUndo(removed);
    try {
      if (ids.length === 1) {
        await onlineUnfavorite(ids[0]);
        await removeOnlineFavoriteIds(ids);
      } else {
        const { failed } = await onlineBulkUnfavorite(ids);
        const ok = ids.filter((id) => !failed.includes(id));
        await removeOnlineFavoriteIds(ok);
      }
    } catch {
    } finally {
      setSelectMode(false);
      clearSelect();
    }
  };

  const renderItem: ListRenderItem<Book> = React.useCallback(
    ({ item, index }) => {
      const id = item.id;
      const isSelected = selected.has(id);
      const isLastInRow = (index + 1) % cols === 0;
      const merged = mergeEnriched(item, enrichedById[id]);

      const anyMerged: any = merged as any;
      const hasAnyTags =
        (Array.isArray(anyMerged?.tags) && anyMerged.tags.length > 0) ||
        (Array.isArray(anyMerged?.artists) && anyMerged.artists.length > 0) ||
        (Array.isArray(anyMerged?.languages) && anyMerged.languages.length > 0);
      if (!hasAnyTags) requestEnrich(id);

      return (
        <View
          style={{
            width: cardWidth,
            marginRight: isLastInRow ? 0 : columnGap,
            marginBottom: columnGap,
            ...(isSingleCol && { alignSelf: "center" }),
          }}
        >
          <View style={{ position: "relative" }}>
            <BookCard
              book={merged}
              cardWidth={cardWidth}
              contentScale={contentScale}
              onPress={() => {
                if (selectMode) toggleSelect(id);
                else onPress?.(id);
              }}
            />

            {selectMode && (
              <Pressable
                onPress={() => toggleSelect(id)}
                style={[StyleSheet.absoluteFill, styles.overlayHit]}
                accessibilityLabel={
                  isSelected
                    ? t("favorites.accessibility.deselect") || "Снять выбор"
                    : t("favorites.accessibility.select") || "Выбрать"
                }
              >
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      backgroundColor: isSelected ? "#00000066" : "#00000022",
                    },
                  ]}
                />
                {isSelected && (
                  <View style={styles.selectedBadge}>
                    <Feather name="check" size={16} color={"#000"} />
                    <Text style={styles.selectedText}>
                      {t("favorites.selected") || "Выбрано"}
                    </Text>
                  </View>
                )}
              </Pressable>
            )}
          </View>
        </View>
      );
    },
    [
      cols,
      cardWidth,
      columnGap,
      isSingleCol,
      contentScale,
      selectMode,
      selected,
      onPress,
      t,
      enrichedById,
      mergeEnriched,
      requestEnrich,
    ]
  );

  const keyExtractor = React.useCallback((b: Book) => String(b.id), []);
  const getItemLayout = undefined;

  const [importOpen, setImportOpen] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const [localBooks, setLocalBooks] = React.useState<Book[]>([]);
  const [localSelected, setLocalSelected] = React.useState<Set<number>>(
    new Set()
  );
  const [localQuery, setLocalQuery] = React.useState("");
  const filteredLocal = React.useMemo(() => {
    const q = localQuery.trim().toLowerCase();
    if (!q) return localBooks;
    return localBooks.filter((b) =>
      (b.title.pretty || "").toLowerCase().includes(q)
    );
  }, [localBooks, localQuery]);

  const loadLocalFavorites = React.useCallback(async () => {
    let localIds: number[] = [];
    try {
      const raw = await AsyncStorage.getItem("bookFavorites");
      localIds = raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      localIds = [];
    }
    if (!localIds.length) {
      Alert.alert(
        t("favorites.import.title") || "Импорт",
        t("favorites.import.noLocal") || "Локальных избранных не найдено."
      );
      return;
    }
    setImportBusy(true);
    try {
      const books = await fetchBooksFromRecommendationLib(
        localIds.slice().reverse(),
        { placeholdersForMissing: true }
      );
      setLocalBooks(books);
      setLocalSelected(new Set());
      setImportOpen(true);
    } catch {
      Alert.alert(
        t("favorites.import.title") || "Импорт",
        t("favorites.import.loadFail") ||
          "Не удалось загрузить локальные избранные."
      );
    } finally {
      setImportBusy(false);
    }
  }, [t]);

  const toggleLocalPick = (id: number) =>
    setLocalSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const importPicked = async () => {
    const ids = Array.from(localSelected);
    if (!ids.length) {
      Alert.alert(
        t("favorites.import.title") || "Импорт",
        t("favorites.import.noneSelected") || "Не выбрано ни одной книги."
      );
      return;
    }
    setImportBusy(true);
    try {
      const { failed } = await bulkAddFavoritesV2(ids);
      const ok = ids.filter((id) => !failed.includes(id));
      await addOnlineFavoriteIds(ok);
      Alert.alert(
        t("favorites.import.doneTitle") || "Готово",
        (t("favorites.import.doneMessage", { count: ok.length }) ||
          `Импортировано: ${ok.length}`) as string
      );
      setImportOpen(false);
    } catch {
      Alert.alert(
        t("favorites.import.title") || "Импорт",
        t("favorites.import.partialFail") ||
          "Часть элементов не удалось импортировать."
      );
    } finally {
      setImportBusy(false);
    }
  };

  const importDisabled = autoImportEnabled;
  const Header = (
    <View
      style={[
        styles.toolbarWrap,
        { borderColor: colors.page, backgroundColor: colors.menuBg },
      ]}
    >
      <View style={styles.toolbarTop}>
        <View style={styles.toolbarRight}>
          <View style={styles.switchWrap}>
            <Text style={{ color: colors.sub, fontSize: 12, marginRight: 6 }}>
              {t("favorites.autoImport.label") || "Авто-импорт (фон)"}
            </Text>
            <Switch
              value={autoImportEnabled}
              onValueChange={setAutoImportEnabled}
              thumbColor={autoImportEnabled ? colors.accent : "#888"}
              trackColor={{ true: colors.accent + "66", false: "#444" }}
            />
            {autoImportEnabled && (
              <View style={[styles.pillSmall, { borderColor: colors.page }]}>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: isRunning ? colors.accent : colors.sub,
                    marginRight: 6,
                  }}
                />
                <Text style={{ color: colors.sub, fontSize: 11 }}>
                  {isRunning
                    ? t("favorites.autoImport.sync") || "синхронизация…"
                    : t("favorites.autoImport.waiting") || "ожидание"}
                </Text>
              </View>
            )}
          </View>

          {!importDisabled ? (
            <CardPressable
              ripple={colors.accent + "33"}
              overlayColor={colors.accent + "11"}
              radius={10}
              onPress={loadLocalFavorites}
              pressedScale={0.98}
            >
              <View style={[styles.btn, { borderColor: colors.page }]}>
                <Feather name="upload" size={14} color={colors.accent} />
                <Text style={[styles.btnTxt, { color: colors.accent }]}>
                  {t("favorites.import.button") || "Импорт из локальных"}
                </Text>
              </View>
            </CardPressable>
          ) : (
            <View style={{ opacity: 0.5 }}>
              <View style={[styles.btn, { borderColor: colors.page }]}>
                <Feather name="pause" size={14} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("favorites.autoImport.active") || "Авто-импорт активен"}
                </Text>
              </View>
            </View>
          )}

          {!selectMode ? (
            <CardPressable
              ripple={colors.accent + "33"}
              overlayColor={colors.accent + "11"}
              radius={10}
              onPress={() => setSelectMode(true)}
              pressedScale={0.98}
            >
              <View style={[styles.btn, { borderColor: colors.page }]}>
                <Feather name="check-square" size={14} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("favorites.selectForDelete") || "Выбрать для удаления"}
                </Text>
              </View>
            </CardPressable>
          ) : (
            <CardPressable
              ripple={colors.accent + "22"}
              overlayColor={colors.accent + "08"}
              radius={10}
              onPress={() => {
                setSelectMode(false);
                clearSelect();
              }}
              pressedScale={0.98}
            >
              <View style={[styles.btn, { borderColor: colors.page }]}>
                <Feather name="x" size={14} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("common.cancelSelection") || "Отменить выбор"}
                </Text>
              </View>
            </CardPressable>
          )}
        </View>
      </View>
    </View>
  );

  const CombinedHeader = (
    <>
      {ListHeaderComponent}
      {!hideToolbar ? Header : null}
    </>
  );

  const EmptyOrLoading =
    loading && items.length === 0
      ? (
          <View style={{ marginTop: 40, alignItems: "center" }}>
            <LoadingSpinner />
          </View>
        )
      : items.length === 0
        ? (ListEmptyComponent as React.ReactElement) ?? (
            <Text
              style={{
                color: colors.sub,
                textAlign: "center",
                marginTop: 40,
              }}
            >
              {t("booklist.notFoundShort") || "Пусто"}
            </Text>
          )
        : null;

  const contentBottomPad = (paddingHorizontal ?? 0) / 2 + 12 + insets.bottom;

  const listRef = React.useRef<FlatList<Book>>(null);
  const flatListRef = scrollRef || listRef;
  const [viewportH, setViewportH] = React.useState(0);
  const [contentH, setContentH] = React.useState(0);
  const contentHRef = React.useRef(0);
  const offsetYRef = React.useRef(0);
  const railDraggingRef = React.useRef(false);
  const dragMaxOffsetRef = React.useRef(0);
  const railRef = React.useRef<FastScrollRailHandle | null>(null);

  const _useWebGrid = Platform.OS === "web";
  const endFiredRef = React.useRef(false);

  const handleWebScroll = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
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
    },
    [onEndReached]
  );

  const renderWebCard = React.useCallback(
    (item: Book, index: number) => {
      const id = item.id;
      const isSelected = selected.has(id);
      const merged = mergeEnriched(item, enrichedById[id]);

      const anyMerged: any = merged as any;
      const hasAnyTags =
        (Array.isArray(anyMerged?.tags) && anyMerged.tags.length > 0) ||
        (Array.isArray(anyMerged?.artists) && anyMerged.artists.length > 0) ||
        (Array.isArray(anyMerged?.languages) && anyMerged.languages.length > 0);
      if (!hasAnyTags) requestEnrich(id);

      return (
        <View
          key={String(item.id)}
          style={{ width: cardWidth }}
        >
          <View style={{ position: "relative" }}>
            <BookCard
              book={merged}
              cardWidth={cardWidth}
              contentScale={contentScale}
              onPress={() => {
                if (selectMode) toggleSelect(id);
                else onPress?.(id);
              }}
            />

            {selectMode && (
              <Pressable
                onPress={() => toggleSelect(id)}
                style={[StyleSheet.absoluteFill, styles.overlayHit]}
                accessibilityLabel={
                  isSelected
                    ? t("favorites.accessibility.deselect") || "Снять выбор"
                    : t("favorites.accessibility.select") || "Выбрать"
                }
              >
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      backgroundColor: isSelected ? "#00000066" : "#00000022",
                    },
                  ]}
                />
                {isSelected && (
                  <View style={styles.selectedBadge}>
                    <Feather name="check" size={16} color={"#000"} />
                    <Text style={styles.selectedText}>
                      {t("favorites.selected") || "Выбрано"}
                    </Text>
                  </View>
                )}
              </Pressable>
            )}
          </View>
        </View>
      );
    },
    [
      cardWidth,
      isSingleCol,
      contentScale,
      selectMode,
      selected,
      onPress,
      t,
      enrichedById,
      mergeEnriched,
      requestEnrich,
    ]
  );

  const webFooter =
    loading && items.length > 0 ? (
      <View style={{ paddingVertical: 16, alignItems: "center" }}>
        <LoadingSpinner />
      </View>
    ) : (
      ListFooterComponent ?? null
    );

  return (
    <View style={[styles.root, { backgroundColor: themeBg }]}>
      {_useWebGrid ? (
        <ScrollView
          style={{ flex: 1, width: "100%" }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          onScroll={handleWebScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingHorizontal,
            paddingTop: (paddingHorizontal ?? 0) / 2,
            paddingBottom: contentBottomPad,
            width: "100%",
            flexGrow: 1,
          }}
        >
          {CombinedHeader}
          {items.length === 0 && !loading ? (
            EmptyOrLoading
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: columnGap, width: "100%" }}>
              {items.map((item, i) => renderWebCard(item, i))}
            </View>
          )}
          {webFooter}
        </ScrollView>
      ) : (
        <FlatList
          ref={flatListRef}
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? { justifyContent: "center" } : undefined}
          ListHeaderComponent={CombinedHeader}
          contentContainerStyle={{
            paddingHorizontal,
            paddingTop: (paddingHorizontal ?? 0) / 2,
            paddingBottom: contentBottomPad,
          }}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setViewportH(h);
          }}
          onContentSizeChange={(_, h) => {
            const prev = contentHRef.current;
            const grew = h > prev + 16;
            const majorShrink = h < prev - 240;
            if (grew || majorShrink) {
              contentHRef.current = h;
              setContentH(h);
              railRef.current?.syncToOffset(offsetYRef.current);
            }
          }}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            offsetYRef.current = y;
            railRef.current?.syncToOffset(y);
          }}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loading && items.length > 0 ? (
              <View style={{ paddingVertical: 16, alignItems: "center" }}>
                <LoadingSpinner />
              </View>
            ) : (
              ListFooterComponent ?? null
            )
          }
          ListEmptyComponent={EmptyOrLoading}
          getItemLayout={getItemLayout as any}
          windowSize={Platform.OS === 'android' ? 5 : 8}
          maxToRenderPerBatch={Platform.OS === 'android' ? 6 : 12}
          initialNumToRender={Platform.OS === 'android' ? Math.min(8, items.length) : Math.min(18, items.length)}
          updateCellsBatchingPeriod={Platform.OS === 'android' ? 50 : 40}
          removeClippedSubviews={Platform.OS === "android"}
        />
      )}
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
            flatListRef.current?.scrollToOffset({
              offset: nextOffset,
              animated: false,
            });
          }}
        />
      ) : null}
      {undoStack.length > 0 && (
        <View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}
        >
          <View
            style={[
              styles.floatingBar,
              {
                backgroundColor: colors.menuBg,
                borderColor: colors.page,
                marginBottom: (selectMode ? 56 : 0) + insets.bottom + 8,
              },
            ]}
          >
            <Text style={{ color: colors.menuTxt, fontWeight: "800" }}>
              {
                (t("favorites.deletedCount", {
                  count: undoStack.length,
                }) || `Удалено ${undoStack.length}`) as string
              }
            </Text>
            <View style={{ flex: 1 }} />
            <CardPressable
              ripple={colors.accent + "33"}
              overlayColor={colors.accent + "11"}
              radius={10}
              onPress={handleUndo}
              pressedScale={0.98}
            >
              <View style={[styles.btnSm, { borderColor: colors.page }]}>
                <Feather name="rotate-ccw" size={14} color={colors.accent} />
                <Text style={[styles.btnTxt, { color: colors.accent }]}>
                  {t("common.undo") || "Отменить"}
                </Text>
              </View>
            </CardPressable>
            <CardPressable
              ripple={colors.accent + "22"}
              overlayColor={colors.accent + "08"}
              radius={10}
              onPress={clearUndo}
              pressedScale={0.98}
              style={{ marginLeft: 8 }}
            >
              <View style={[styles.btnSm, { borderColor: colors.page }]}>
                <Feather name="x" size={14} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("common.hide") || "Скрыть"}
                </Text>
              </View>
            </CardPressable>
          </View>
        </View>
      )}

      {selectMode && (
        <View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, { justifyContent: "flex-end" }]}
        >
          <View
            style={[
              styles.selectionBar,
              {
                backgroundColor: colors.menuBg,
                borderColor: colors.page,
                paddingBottom: 8 + insets.bottom,
              },
            ]}
          >
            <Text style={{ color: colors.menuTxt, fontWeight: "800" }}>
              {
                (t("favorites.selectedCount", {
                  count: selected.size,
                }) || `Выбрано: ${selected.size}`) as string
              }
            </Text>
            <View style={{ flex: 1 }} />
            <CardPressable
              ripple={colors.accent + "22"}
              overlayColor={colors.accent + "08"}
              radius={12}
              onPress={() => {
                setSelectMode(false);
                clearSelect();
              }}
              pressedScale={0.98}
            >
              <View style={[styles.btnLg, { borderColor: colors.page }]}>
                <Feather name="x" size={16} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("common.cancelSelection") || "Отменить"}
                </Text>
              </View>
            </CardPressable>
            <CardPressable
              ripple={colors.accent + "33"}
              overlayColor={colors.accent + "11"}
              radius={12}
              onPress={() => {
                const ids = Array.from(selected);
                if (!ids.length) return;
                Alert.alert(
                  t("favorites.deleteOnline.title") ||
                    "Удалить из онлайн-избранного",
                  (t("favorites.deleteOnline.message", {
                    count: ids.length,
                  }) || `Выбрано: ${ids.length}. Подтвердить?`) as string,
                  [
                    {
                      text: t("common.cancel") || "Отмена",
                      style: "cancel",
                    },
                    {
                      text: t("common.delete") || "Удалить",
                      style: "destructive",
                      onPress: () => runMassDelete(ids),
                    },
                  ]
                );
              }}
              pressedScale={0.98}
              style={{ marginLeft: 8 }}
            >
              <View style={[styles.btnLg, { borderColor: colors.page }]}>
                <Feather name="trash-2" size={16} color={colors.accent} />
                <Text style={[styles.btnTxt, { color: colors.accent }]}>
                  {t("common.delete") || "Удалить"}
                </Text>
              </View>
            </CardPressable>
          </View>
        </View>
      )}

      <Modal
        statusBarTranslucent
        visible={importOpen}
        animationType="slide"
        onRequestClose={() => setImportOpen(false)}
      >
        <View style={[styles.modalRoot, { backgroundColor: colors.page }]}>
          <View style={{ height: insets.top }} />
          <View style={[styles.modalHeader, { borderColor: colors.page }]}>
            <Text style={[styles.title, { color: colors.title }]}>
              {t("favorites.import.modalTitle") || "Импорт локальных"}
            </Text>
            <View style={{ flex: 1 }} />
            <CardPressable
              ripple={colors.accent + "22"}
              overlayColor={colors.accent + "08"}
              radius={10}
              onPress={() => setImportOpen(false)}
              pressedScale={0.98}
            >
              <View style={[styles.btn, { borderColor: colors.page }]}>
                <Feather name="x" size={16} color={colors.menuTxt} />
                <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                  {t("common.close") || "Закрыть"}
                </Text>
              </View>
            </CardPressable>
          </View>

          <View style={[styles.importControls, { borderColor: colors.page }]}>
            <View style={styles.searchBox}>
              <Feather name="search" size={14} color={colors.sub} />
              <TextInput
                placeholder={t("common.searchPlaceholder") || "Поиск…"}
                placeholderTextColor={colors.sub}
                style={{
                  color: colors.title,
                  flex: 1,
                  paddingVertical: 6,
                }}
                value={localQuery}
                onChangeText={setLocalQuery}
              />
            </View>

            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <CardPressable
                ripple={colors.accent + "22"}
                overlayColor={colors.accent + "08"}
                radius={10}
                onPress={() =>
                  setLocalSelected(new Set(filteredLocal.map((b) => b.id)))
                }
                pressedScale={0.98}
              >
                <View style={[styles.btn, { borderColor: colors.page }]}>
                  <Feather name="check" size={14} color={colors.menuTxt} />
                  <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                    {t("common.selectAll") || "Выбрать всё"}
                  </Text>
                </View>
              </CardPressable>
              <CardPressable
                ripple={colors.accent + "22"}
                overlayColor={colors.accent + "08"}
                radius={10}
                onPress={() => setLocalSelected(new Set())}
                pressedScale={0.98}
              >
                <View style={[styles.btn, { borderColor: colors.page }]}>
                  <Feather name="square" size={14} color={colors.menuTxt} />
                  <Text style={[styles.btnTxt, { color: colors.menuTxt }]}>
                    {t("common.clearSelection") || "Снять всё"}
                  </Text>
                </View>
              </CardPressable>
              <CardPressable
                ripple={colors.accent + "33"}
                overlayColor={colors.accent + "11"}
                radius={10}
                onPress={importPicked}
                pressedScale={0.98}
              >
                <View style={[styles.btn, { borderColor: colors.page }]}>
                  {importBusy ? (
                    <LoadingSpinner size="small" />
                  ) : (
                    <Feather name="upload" size={14} color={colors.accent} />
                  )}
                  <Text style={[styles.btnTxt, { color: colors.accent }]}>
                    {
                      (t("favorites.import.importSelected", {
                        count: localSelected.size || 0,
                      }) ||
                        `Импортировать ${localSelected.size || ""}`) as string
                    }
                  </Text>
                </View>
              </CardPressable>
            </View>
          </View>

          <FlatList
            data={filteredLocal}
            keyExtractor={(b) => String(b.id)}
            numColumns={width >= 768 ? 5 : 3}
            columnWrapperStyle={{ justifyContent: "center" }}
            contentContainerStyle={{
              paddingHorizontal: 12,
              paddingBottom: 12 + insets.bottom,
              paddingTop: 8,
            }}
            renderItem={({ item }) => {
              const picked = localSelected.has(item.id);
              const tileW = Math.min(
                220,
                Math.max(
                  128,
                  (width - 12 * 2 - 10 * 2) / (width >= 768 ? 5 : 3)
                )
              );
              return (
                <View style={{ width: tileW, margin: 5 }}>
                  <View style={{ position: "relative" }}>
                    <BookCard
                      book={item}
                      cardWidth={tileW}
                      contentScale={0.65}
                      onPress={() => toggleLocalPick(item.id)}
                    />
                    <Pressable
                      onPress={() => toggleLocalPick(item.id)}
                      style={[StyleSheet.absoluteFill, styles.overlayHit]}
                    >
                      <View
                        style={[
                          StyleSheet.absoluteFill,
                          {
                            backgroundColor: picked ? "#00000066" : "#00000022",
                          },
                        ]}
                      />
                      {picked && (
                        <View style={styles.selectedBadge}>
                          <Feather name="check" size={16} color={"#000"} />
                          <Text style={styles.selectedText}>
                            {t("favorites.selected") || "Выбрано"}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              importBusy ? (
                <View style={{ marginTop: 24 }}>
                  <LoadingSpinner />
                </View>
              ) : (
                <Text
                  style={{
                    color: colors.sub,
                    textAlign: "center",
                    marginTop: 24,
                  }}
                >
                  {t("booklist.notFound") || "Ничего не найдено ¯\\_(ツ)_/¯"}
                </Text>
              )
            }
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontWeight: "900", fontSize: 15, letterSpacing: 0.2 },
  toolbarWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
  },
  toolbarTop: {
    flexDirection: "row",
    alignItems: "center",
  },
  toolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: "auto",
    flexWrap: "wrap",
  },
  switchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 6,
  },
  pillSmall: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginLeft: 8,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
  },
  btnSm: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
  },
  btnLg: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  btnTxt: { fontWeight: "800", fontSize: 12, letterSpacing: 0.2 },
  overlayHit: { justifyContent: "center", alignItems: "center" },
  selectedBadge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  selectedText: {
    color: "#000",
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0.2,
  },
  floatingBar: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
  },
  selectionBar: {
    marginHorizontal: 10,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingTop: 8,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
  },
  modalRoot: { flex: 1 },
  modalHeader: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  importControls: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
