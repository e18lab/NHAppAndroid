import type { Book } from "@/api/nhappApi/types";
import type { GalleryComment } from "@/api/nhappApi/types";
import { ApiError } from "@/api/v2/client";
import { getGalleryComments, getRelatedGalleries } from "@/api/v2";
import { commentToGalleryComment, galleryRelatedToBook } from "@/api/v2/compat";
import { useCallback, useEffect, useState } from "react";
import { InteractionManager } from "react-native";

export const useRelatedComments = (book: Book | null) => {
  const [related, setRelated] = useState<Book[]>([]);
  const [relLoading, setRelLoading] = useState(false);
  const [allComments, setAllComments] = useState<GalleryComment[]>([]);
  const [visibleCount, setVisibleCount] = useState(20);
  const [cmtLoading, setCmtLoading] = useState(false);
  const isRateLimitError = (err: unknown) =>
    (err instanceof ApiError && err.status === 429) ||
    String((err as any)?.message || "").toLowerCase().includes("rate limit");

  const refetchRelated = useCallback(async () => {
    if (!book) return;
    if (!book.id || book.id <= 0) {
      setRelated([]);
      return;
    }
    try {
      setRelLoading(true);
      const r = await getRelatedGalleries(book.id);
      setRelated(r.slice(0, 5).map(galleryRelatedToBook));
    } catch (err: any) {
      console.error("[useRelatedComments] Error fetching related books:", err?.message || err);
      setRelated([]);
    } finally {
      setRelLoading(false);
    }
  }, [book?.id]);

  const refetchComments = useCallback(async () => {
    if (!book) return;
    if (!book.id || book.id <= 0) {
      setAllComments([]);
      setVisibleCount(0);
      return;
    }
    try {
      setCmtLoading(true);
      const cs = await getGalleryComments(book.id);
      setAllComments(cs.map(commentToGalleryComment));
      setVisibleCount(20);
    } catch (err: any) {
      if (!isRateLimitError(err)) {
        console.warn("[useRelatedComments] Error fetching comments:", err?.message || err);
        setAllComments([]);
        setVisibleCount(0);
      }
    } finally {
      setCmtLoading(false);
    }
  }, [book?.id]);

  useEffect(() => {
    if (!book) {
      setRelated([]);
      setAllComments([]);
      return;
    }
    const timeoutId = setTimeout(() => {
      refetchRelated();
      refetchComments();
    }, 100);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [book?.id]);

  return {
    related,
    relLoading,
    refetchRelated,
    allComments,
    visibleCount,
    setVisibleCount,
    cmtLoading,
    refetchComments,
  };
};
