import { useGridConfig } from "@/hooks/useGridConfig";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";

import { Book, searchBooks } from "@/api/nhentai";
import BookList from "@/components/BookList";
import PaginationBar from "@/components/PaginationBar";
import { useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function ExploreScreen() {
  const { query: rawQ, solo: rawSolo } = useLocalSearchParams<{
    query?: string | string[];
    solo?: string | string[];
  }>();
  const urlQ = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  const solo = Array.isArray(rawSolo) ? rawSolo[0] : rawSolo;

  const [query, setQuery] = useState(urlQ ?? "");

  const { sort } = useSort();
  const { includes, excludes } = useFilterTags();

  const useFilters = solo !== "1";
  const activeIncludes = useFilters ? includes : [];
  const activeExcludes = useFilters ? excludes : [];

  const incStr = JSON.stringify(activeIncludes);
  const excStr = JSON.stringify(activeExcludes);

  const [books, setBooks] = useState<Book[]>([]);
  const [totalPages, setTotal] = useState(1);
  const [currentPage, setPage] = useState(1);
  const [favorites, setFav] = useState<Set<number>>(new Set());
  const [refreshing, setRef] = useState(false);

  const listRef = useRef<FlatList>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const gridConfig = useGridConfig();

  useEffect(() => {
    AsyncStorage.getItem("bookFavorites").then(
      (j) => j && setFav(new Set(JSON.parse(j)))
    );
  }, []);

  const fetchPage = useCallback(
    async (page: number) => {
      const q = query.trim();
      if (!q) {
        setBooks([]);
        setTotal(1);
        return;
      }
      try {
        const res = await searchBooks({
          query: q,
          sort,
          page,
          includeTags: activeIncludes,
          excludeTags: activeExcludes,
        });
        setBooks(res.books);
        setTotal(res.totalPages);
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
      } catch (error) {
        console.error("Failed to fetch books:", error);
      }
    },
    [query, sort, incStr, excStr]
  );

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setBooks([]);
      setTotal(1);
      return;
    }
    fetchPage(currentPage);
  }, [currentPage, query, sort, incStr, excStr, fetchPage]);

  useEffect(() => {
    setPage(1);
  }, [query, sort, incStr, excStr]);

  useEffect(() => {
    setQuery(urlQ ?? "");
  }, [urlQ]);

  const onRefresh = useCallback(async () => {
    setRef(true);
    await fetchPage(currentPage);
    setRef(false);
  }, [currentPage, fetchPage]);

  const toggleFav = useCallback((id: number, next: boolean) => {
    setFav((prev) => {
      const cp = new Set(prev);
      if (next) cp.add(id);
      else cp.delete(id);
      AsyncStorage.setItem("bookFavorites", JSON.stringify([...cp]));
      return cp;
    });
  }, []);

  return (
    <View style={styles.container}>
      <BookList
        data={books}
        loading={books.length === 0 && currentPage === 1 && !!query}
        refreshing={refreshing}
        onRefresh={onRefresh}
        isFavorite={(id) => favorites.has(id)}
        onToggleFavorite={toggleFav}
        onPress={(id) =>
          router.push({ pathname: "/book/[id]", params: { id: String(id) } })
        }
        gridConfig={{ default: gridConfig }}
      />
      <PaginationBar
        currentPage={currentPage}
        totalPages={totalPages}
        onChange={setPage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
