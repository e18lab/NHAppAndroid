import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import LoadingSpinner from "@/components/LoadingSpinner";
import * as DocumentPicker from "expo-document-picker";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { requestStoragePush } from "@/api/nhappApi/cloudStorage";
import type { Book } from "@/api/nhappApi/types";
import { searchGalleries } from "@/api/v2";
import { galleryCardToBook, buildV2Query } from "@/api/v2/compat";
import SmartImage from "@/components/SmartImage";
import { buildImageFallbacks } from "@/components/buildImageFallbacks";
import { useDateRange } from "@/context/DateRangeContext";
import { useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useTheme } from "@/lib/ThemeContext";
import { isBookBlacklisted, useBlacklistNameSet, useBlacklistSet } from "@/lib/blacklistFilter";
import { setImsearchPendingFile } from "@/lib/imsearchPendingUpload";
import { useI18n } from "@/lib/i18n/I18nContext";
import { BROWSE_CARDS_PER_PAGE } from "@/utils/browseGridPageSize";
const KEY_HISTORY = "searchHistory";
const BAR_H = 52;
const BTN_SIDE = 40;

function isNumericBookId(s: string): boolean {
  return /^\d+$/.test(s.trim());
}

function pickImageFileWeb(): Promise<File | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function pickImageForSearch(): Promise<File | { uri: string; name: string; type: string } | null> {
  if (Platform.OS === "web") {
    return pickImageFileWeb();
  }
  const res = await DocumentPicker.getDocumentAsync({
    type: "image/*",
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.name || "image.jpg",
    type: a.mimeType || "image/jpeg",
  };
}
function IconBtn({
  onPress,
  onLongPress,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.iconBtnRound,
        pressed && { backgroundColor: colors.accent + "22" },
      ]}
    >
      {children}
    </Pressable>
  );
}
function RowPress({
  onPress,
  children,
}: {
  onPress?: () => void;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.rowPress,
        styles.rounded,
        pressed && { backgroundColor: colors.accent + "15" },
      ]}
    >
      {children}
    </Pressable>
  );
}
export default function SearchScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const { includes, excludes } = useFilterTags();
  const { sort } = useSort();
  const blacklistIds = useBlacklistSet();
  const blacklistNames = useBlacklistNameSet();
  const { uploaded, clearUploaded } = useDateRange();
  const dateFilterActive = !!uploaded;
  const params = useLocalSearchParams<{ query?: string | string[] }>();
  const queryParam = typeof params.query === "string" ? params.query : "";
  const [q, setQ] = useState(queryParam);
  const [history, setHist] = useState<string[]>([]);
  const [suggests, setSug] = useState<Book[]>([]);
  const [loading, setLoad] = useState(false);
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    AsyncStorage.getItem(KEY_HISTORY).then((j) => j && setHist(JSON.parse(j)));
  }, []);
  useEffect(() => {
    setQ(queryParam);
  }, [queryParam]);
  const saveHist = async (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const next = [clean, ...history.filter((h) => h !== clean)].slice(0, 10);
    setHist(next);
    await AsyncStorage.setItem(KEY_HISTORY, JSON.stringify(next));
    requestStoragePush();
  };
  const submit = async (text = q) => {
    const query = text.trim();
    if (!query) return;
    Keyboard.dismiss();
    if (isNumericBookId(query)) {
      await saveHist(query);
      router.push({
        pathname: "/book/[id]",
        params: { id: query, title: "" },
      });
      return;
    }
    await saveHist(query);
    router.push({ pathname: "/explore", params: { query } });
  };

  const onSearchByImage = async () => {
    try {
      const picked = await pickImageForSearch();
      if (!picked) return;
      Keyboard.dismiss();
      if (Platform.OS === "web" && picked instanceof File) {
        setImsearchPendingFile({ kind: "web", file: picked });
      } else if ("uri" in picked) {
        setImsearchPendingFile({
          kind: "native",
          uri: picked.uri,
          name: picked.name,
          type: picked.type,
        });
      } else {
        return;
      }
      router.push({
        pathname: "/explore",
        params: { imsearch: "1", imt: String(Date.now()) },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert(t("toast.errorTitle"), msg);
    }
  };
  const incStr = JSON.stringify(includes);
  const excStr = JSON.stringify(excludes);
  useEffect(() => {
    const query = q.trim();
    if (!query || dateFilterActive || isNumericBookId(query)) {
      setSug([]);
      setLoad(false);
      return;
    }
    setLoad(true);
    const tmo = setTimeout(async () => {
      try {
        const v2Query = buildV2Query(query, includes, excludes);
        const res = await searchGalleries({
          query: v2Query,
          sort,
          per_page: BROWSE_CARDS_PER_PAGE,
        });
        const next = res.result.map(galleryCardToBook);
        const filtered =
          blacklistIds.size || blacklistNames.size
            ? next.filter((b) => !isBookBlacklisted(b, blacklistIds, blacklistNames))
            : next;
        setSug(filtered);
      } finally {
        setLoad(false);
      }
    }, 250);
    return () => clearTimeout(tmo);
  }, [q, sort, incStr, excStr, dateFilterActive]);
  const trimmed = q.trim();
  const filteredHistory = useMemo(
    () =>
      trimmed
        ? history.filter((h) => h.toLowerCase().includes(trimmed.toLowerCase()))
        : history,
    [history, trimmed]
  );
  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View
        style={[
          styles.topBar,
          { backgroundColor: colors.searchBg, borderBottomColor: colors.page },
        ]}
      >
        <View style={[styles.row, { paddingHorizontal: 8, height: BAR_H }]}>
          <IconBtn onPress={() => router.back()}>
            <Feather name="arrow-left" size={20} color={colors.searchTxt} />
          </IconBtn>
          <View
            style={[
              styles.inputWrap,
              styles.searchInputRounded,
              { backgroundColor: colors.page, borderColor: colors.page },
            ]}
          >
            <Feather
              name="search"
              size={18}
              color={colors.sub}
              style={{ marginHorizontal: 6 }}
            />
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: colors.searchTxt }]}
              placeholder={t("search.placeholder")}
              placeholderTextColor={colors.sub}
              value={q}
              onChangeText={setQ}
              onSubmitEditing={() => submit()}
              autoFocus
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {q !== "" && (
              <Pressable
                hitSlop={10}
                style={({ pressed }) => [
                  styles.iconBtnSmallRound,
                  pressed && { backgroundColor: colors.accent + "22" },
                ]}
                onPress={() => setQ("")}
              >
                <Feather name="x" size={16} color={colors.sub} />
              </Pressable>
            )}
            <Pressable
              hitSlop={8}
              onPress={onSearchByImage}
              accessibilityRole="button"
              accessibilityLabel={t("search.searchByImage")}
              style={({ pressed }) => [
                styles.iconBtnSmallRound,
                pressed && { backgroundColor: colors.accent + "22" },
              ]}
            >
              <Feather name="image" size={18} color={colors.accent} />
            </Pressable>
          </View>
          <IconBtn onPress={() => router.push("/tags")}>
            <Feather name="tag" size={18} color={colors.accent} />
          </IconBtn>
        </View>
      </View>
      {trimmed.length > 0 && (
        <View
          style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: colors.sub }}>
            {t("search.results")}:{" "}
            <Text style={{ color: colors.searchTxt }}>{trimmed}</Text>
          </Text>
        </View>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 16 }}
      >
        {filteredHistory.length > 0 && (
          <>
            <View style={styles.headRow}>
              <Text style={[styles.headTxt, { color: colors.sub }]}>
                {t("search.recent")}
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.pillBtn,
                  styles.rounded,
                  pressed && { backgroundColor: colors.accent + "15" },
                ]}
                onPress={async () => {
                  setHist([]);
                  await AsyncStorage.removeItem(KEY_HISTORY);
                }}
              >
                <Text style={[styles.pillBtnTxt, { color: colors.sub }]}>
                  {t("search.clearHistory")}
                </Text>
              </Pressable>
            </View>
            {filteredHistory.map((item) => (
              <View key={item} style={styles.rowItem}>
                <RowPress onPress={() => submit(item)}>
                  <Feather
                    name="clock"
                    size={16}
                    color={colors.sub}
                    style={{ marginRight: 8 }}
                  />
                  <Text
                    style={[styles.rowTxt, { color: colors.searchTxt }]}
                    numberOfLines={1}
                  >
                    {item}
                  </Text>
                </RowPress>
                <Pressable
                  hitSlop={10}
                  style={({ pressed }) => [
                    styles.iconBtnSmallRound,
                    pressed && { backgroundColor: colors.accent + "22" },
                  ]}
                  onPress={async () => {
                    const next = history.filter((h) => h !== item);
                    setHist(next);
                    await AsyncStorage.setItem(
                      KEY_HISTORY,
                      JSON.stringify(next)
                    );
                    requestStoragePush();
                  }}
                >
                  <Feather name="x" size={16} color={colors.sub} />
                </Pressable>
              </View>
            ))}
          </>
        )}
        {trimmed.length > 0 && (
          <>
            <Text
              style={[
                styles.headTxt,
                {
                  color: colors.sub,
                  marginTop: filteredHistory.length ? 14 : 2,
                },
              ]}
            >
              {t("search.results")}
            </Text>
            {dateFilterActive ? (
              <View
                style={[
                  styles.rounded,
                  {
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    backgroundColor: colors.accent + "12",
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.page,
                    marginTop: 8,
                  },
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Feather name="calendar" size={16} color={colors.accent} />
                  <Text
                    style={{
                      color: colors.searchTxt,
                      marginLeft: 8,
                      fontWeight: "700",
                    }}
                  >
                    Предпросмотр не работает с датами
                  </Text>
                </View>
                <Text
                  style={{
                    color: colors.sub,
                    marginTop: 6,
                    lineHeight: 18,
                  }}
                >
                  Открой результаты или{" "}
                  <Text
                    onPress={clearUploaded}
                    style={{ color: colors.accent, fontWeight: "800" }}
                  >
                    сбрось даты
                  </Text>
                  , чтобы увидеть быстрые подсказки.
                </Text>
              </View>
            ) : (
              <>
                {loading && (
                  <LoadingSpinner
                    size="small"
                    color={colors.sub}
                  />
                )}
                {!loading &&
                  suggests.map((b) => (
                    <RowPress
                      key={b.id}
                      onPress={() =>
                        router.push({
                          pathname: "/book/[id]",
                          params: { id: String(b.id), title: b.title.pretty },
                        })
                      }
                    >
                      <SmartImage
                        sources={buildImageFallbacks(b.thumbnail)}
                        style={styles.thumb}
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[styles.rowTxt, { color: colors.searchTxt }]}
                          numberOfLines={1}
                        >
                          {b.title.pretty}
                        </Text>
                        <Text style={[styles.metaTxt, { color: colors.sub }]}>
                          {t("book.pages", { count: b.pagesCount })}
                        </Text>
                      </View>
                    </RowPress>
                  ))}
                {!loading && suggests.length === 0 && (
                  <Text
                    style={[
                      styles.metaTxt,
                      {
                        color: colors.sub,
                        textAlign: "center",
                        marginTop: 12,
                      },
                    ]}
                  >
                    {t("empty.search", { q: trimmed })}
                  </Text>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    elevation: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: "row", alignItems: "center" },
  rounded: { borderRadius: 12, overflow: "hidden" },
  searchInputRounded: { borderRadius: 20, overflow: "hidden" },
  iconBtnRound: {
    width: BTN_SIDE,
    height: BTN_SIDE,
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnSmallRound: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    flex: 1,
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    marginHorizontal: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 0 },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    marginBottom: 6,
  },
  pillBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  pillBtnTxt: { fontSize: 11, fontWeight: "700" },
  headTxt: { fontSize: 11, letterSpacing: 0.5, fontWeight: "700" },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    gap: 6,
  },
  rowPress: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  rowTxt: { fontSize: 14, flex: 1 },
  metaTxt: { fontSize: 12 },
  thumb: { width: 50, height: 70, borderRadius: 8, marginRight: 10 },
});
