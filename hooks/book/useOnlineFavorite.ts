import { addFavorite, isFavorited, removeFavorite } from "@/api/v2";
import { getAuthStorageReady } from "@/api/v2/client";
import {
  addOnlineFavoriteIds,
  removeOnlineFavoriteIds,
} from "@/lib/onlineFavoritesStorage";
import { useCallback, useEffect, useState } from "react";

function coerceIsFavorited(payload: unknown): boolean | null {
  if (typeof payload === "boolean") return payload;
  if (!payload || typeof payload !== "object") return null;
  const anyP = payload as any;
  const v =
    anyP.is_favorited ??
    anyP.isFavorited ??
    anyP.favorited ??
    anyP.is_favorite ??
    anyP.favorite;
  return typeof v === "boolean" ? v : null;
}

/**
 * Manages the online (server-side) favorite state for a gallery.
 * Only operates when the user is authenticated (meId != null).
 */
export const useOnlineFavorite = (
  galleryId: number,
  meId: number | null,
  initialLiked?: boolean
) => {
  const [onlineLiked, setOnlineLiked] = useState(!!initialLiked);
  const [likeLoading, setLikeLoading] = useState(false);

  useEffect(() => {
    if (!meId || !galleryId || galleryId <= 0) {
      setOnlineLiked(false);
      return;
    }
    // Seed from preloaded gallery include=favorite to avoid waiting for /favorite.
    if (typeof initialLiked === "boolean") {
      setOnlineLiked(initialLiked);
    }
    let alive = true;
    (async () => {
      try {
        // Prevent race: token migration / AsyncStorage readiness
        await getAuthStorageReady();
        const payload = await isFavorited(galleryId);
        const v = coerceIsFavorited(payload);
        if (alive && v !== null) setOnlineLiked(v);
      } catch {
        // keep previous state on transient errors
        if (__DEV__) console.warn("[useOnlineFavorite] isFavorited failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [galleryId, meId, initialLiked]);

  const toggleOnlineLike = useCallback(async () => {
    if (!meId || likeLoading) return;
    setLikeLoading(true);
    const wasLiked = onlineLiked;
    setOnlineLiked(!wasLiked); // optimistic
    try {
      await getAuthStorageReady();
      if (wasLiked) {
        await removeFavorite(galleryId);
        await removeOnlineFavoriteIds([galleryId]);
      } else {
        await addFavorite(galleryId);
        await addOnlineFavoriteIds([galleryId]);
      }
    } catch {
      setOnlineLiked(wasLiked); // rollback
    } finally {
      setLikeLoading(false);
    }
  }, [galleryId, onlineLiked, meId, likeLoading]);

  return { onlineLiked, toggleOnlineLike, likeLoading };
};
