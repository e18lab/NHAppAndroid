import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Keyboard,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import { Book, searchBooks } from "@/api/nhentai";
import SmartImage from "@/components/SmartImage";
import { buildImageFallbacks } from "@/components/buildImageFallbacks";
import { useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useTheme } from "@/lib/ThemeContext";

const KEY_HISTORY = "searchHistory";
const BAR_H = 52;
const BTN_SIDE = 40;

/** Кнопка-иконка с круглым «pressed» фоном, без android_ripple */
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

/** Ряд списка с мягкой подсветкой по нажатию */
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
  const router = useRouter();

  const { includes, excludes } = useFilterTags();
  const { sort } = useSort();

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
  };
  const submit = async (text = q) => {
    const query = text.trim();
    if (!query) return;
    await saveHist(query);
    Keyboard.dismiss();
    router.push({ pathname: "/explore", params: { query } });
  };

  const incStr = JSON.stringify(includes);
  const excStr = JSON.stringify(excludes);
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setSug([]);
      return;
    }
    setLoad(true);
    const t = setTimeout(async () => {
      try {
        const { books } = await searchBooks({
          query,
          perPage: 8,
          sort,
          includeTags: includes,
          excludeTags: excludes,
        });
        setSug(books);
      } finally {
        setLoad(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, sort, incStr, excStr]);

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
              styles.rounded,
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
              placeholder="Search…"
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
            Ищу: <Text style={{ color: colors.searchTxt }}>{trimmed}</Text>
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
                HISTORY
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
                  clear
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
              RESULTS
            </Text>

            {loading && (
              <ActivityIndicator
                size="small"
                color={colors.sub}
                style={{ marginVertical: 12 }}
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
                      {b.pagesCount} pages
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
                Ничего не найдено
              </Text>
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
