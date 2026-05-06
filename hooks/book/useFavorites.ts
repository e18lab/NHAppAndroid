import {
  requestStoragePush,
  subscribeToStorageApplied,
} from "@/api/nhappApi/cloudStorage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
const FAVORITES = "bookFavorites";

function parseFavoritesSet(raw: string | null): Set<number> {
  try {
    const arr: number[] = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export const useFavorites = (currentId: number) => {
  const [favorites, setFav] = useState<Set<number>>(new Set());
  const [liked, setLiked] = useState(false);
  const reload = useCallback(() => {
    AsyncStorage.getItem(FAVORITES).then((j) => {
      const s = parseFavoritesSet(j);
      setFav(s);
      setLiked(s.has(currentId));
    });
  }, [currentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => subscribeToStorageApplied(reload), [reload]);
  const toggleFav = useCallback(async (bid: number, next: boolean) => {
    const j = await AsyncStorage.getItem(FAVORITES);
    const s = parseFavoritesSet(j);
    if (next) s.add(bid);
    else s.delete(bid);
    const nextArr = [...s];
    await AsyncStorage.setItem(FAVORITES, JSON.stringify(nextArr));
    setFav(s);
    if (bid === currentId) setLiked(next);
    requestStoragePush();
  }, [currentId]);
  const toggleLike = useCallback(async () => {
    const j = await AsyncStorage.getItem(FAVORITES);
    const arr: number[] = j ? JSON.parse(j) : [];
    const nextArr = arr.includes(currentId)
      ? arr.filter((x) => x !== currentId)
      : [...arr, currentId];
    setLiked(!arr.includes(currentId));
    setFav(new Set(nextArr));
    await AsyncStorage.setItem(FAVORITES, JSON.stringify(nextArr));
    requestStoragePush();
  }, [currentId]);
  return { favorites, toggleFav, liked, toggleLike };
};
