import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Book } from "@/api/nhentai";
import { getFavoritesOnline, getMe } from "@/api/nhentaiOnline";
import BookList from "@/components/BookList";
import { useGridConfig } from "@/hooks/useGridConfig";
import { useTheme } from "@/lib/ThemeContext";

export default function FavoritesOnlineScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const gridConfig = useGridConfig();

  const [books, setBooks] = useState<Book[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  // auth
  const [hasAuth, setHasAuth] = useState(false);
  const [authChecked, setAuthChecked] = useState(false); // чтобы не показывать «требуется вход» до завершения проверки

  const checkAuth = useCallback(async () => {
    try {
      const me = await getMe();
      setHasAuth(!!me);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useFocusEffect(
    useCallback(() => {
      setAuthChecked(false); // перезапускаем индикатор проверки
      checkAuth();
    }, [checkAuth])
  );

  const loadPage = useCallback(
    async (pageNum: number) => {
      if (!hasAuth) {
        setBooks([]);
        setPage(1);
        setTotalPages(1);
        return;
      }
      const { books: fetched, totalPages: tp } = await getFavoritesOnline({ page: pageNum });
      setBooks((prev) => (pageNum === 1 ? fetched : [...prev, ...fetched]));
      setTotalPages(tp);
      setPage(pageNum);
    },
    [hasAuth]
  );

  useEffect(() => {
    loadPage(1);
  }, [hasAuth, loadPage]);

  const onEnd = () => {
    if (page < totalPages) loadPage(page + 1);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPage(1);
    setRefreshing(false);
  }, [loadPage]);

  const isFavorite = useCallback(() => true, []);
  const onToggleFavorite = useCallback(() => {
    // no-op
  }, []);

  const Empty =
    !authChecked
      ? undefined
      : !hasAuth
      ? (
        <Text style={{ textAlign: "center", marginTop: 40, color: colors.sub }}>
          Требуется вход. Откройте экран логина и авторизуйтесь.
        </Text>
      )
      : undefined;

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      <BookList
        data={books}
        loading={hasAuth && books.length === 0}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onEndReached={onEnd}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        onPress={(id) =>
          router.push({
            pathname: "/book/[id]",
            params: { id: String(id), title: books.find((b) => b.id === id)?.title.pretty },
          })
        }
        ListEmptyComponent={Empty}
        gridConfig={{ default: gridConfig }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
