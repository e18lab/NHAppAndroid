/**
 * Batch metadata from nhapp-api recommendation_lib (PostgreSQL), not nhentai.
 * GET {EXPO_PUBLIC_API_BASE_URL}/api/recommendation-lib/books/batch?q=1,2,3
 */

import type { Book, Tag } from "@/api/nhappApi/types";
import { galleryToBook } from "@/api/v2/compat";
import { initCdn, resolveThumbUrl } from "@/api/v2/config";
import { getGallery } from "@/api/v2/galleries";
import { resolveLoopbackToPackagerHost } from "@/config/api";

function isElectronRenderer(): boolean {
  return typeof window !== "undefined" && !!(window as any).electron?.isElectron;
}

async function fetchJsonCompat<T>(url: string): Promise<T> {
  // Electron renderer served from app:// can hit CORS issues with plain fetch.
  // Use the preload bridge when available (main process fetch) to bypass CORS.
  if (isElectronRenderer()) {
    const e = (window as any).electron;
    if (e?.fetchJson) {
      const res = await e.fetchJson(url, {});
      if (res && typeof res === "object" && "success" in res) {
        if ((res as any).success) {
          if ((res as any).data != null) return (res as any).data as T;
          const body = (res as any).body;
          if (typeof body === "string" && body.trim()) {
            try {
              return JSON.parse(body) as T;
            } catch (e2: any) {
              throw new Error(`electron.fetchJson invalid JSON: ${e2?.message || e2}`);
            }
          }
          throw new Error("electron.fetchJson empty body");
        }
        throw new Error((res as any).error || `electron.fetchJson failed (status ${(res as any).status ?? "?"})`);
      }
      // Some older bridges may return raw JSON.
      return res as T;
    }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function nhappApiBase(): string {
  const raw = (
    process.env.EXPO_PUBLIC_API_BASE_URL || "https://nhapp-api.onrender.com"
  ).replace(/\/$/, "");
  return resolveLoopbackToPackagerHost(raw).replace(/\/$/, "");
}

export interface RecommendationLibBatchRow {
  book_id: number;
  /** Из PostgreSQL может прийти строкой */
  media_id?: number | string | null;
  title_english?: string | null;
  title_japanese?: string | null;
  title_pretty?: string | null;
  parodies?: unknown;
  characters?: unknown;
  artists?: unknown;
  groups?: unknown;
  languages?: unknown;
  categories?: unknown;
  pages?: number;
  uploaded_at?: string | null;
  tags?: string[];
}

/**
 * CDN: только `media_id` в сегменте пути (как на сайте).
 * Итог после resolveThumbUrl: `https://t1.nhentai.net/galleries/3864731/thumb.webp` (хост с /config).
 * Без media_id в batch — путь пустой; тогда `hydrateMissingThumbnails` подтягивает галерею по id.
 */
function parsePositiveId(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function thumbUrlForRecommendationRow(row: RecommendationLibBatchRow): string {
  const mediaId = parsePositiveId(row.media_id);
  if (mediaId == null) return "";
  return resolveThumbUrl(`/galleries/${mediaId}/thumb.webp`);
}

function jsonStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toDisplayTags(names: string[], type: string): Tag[] {
  return names.map((name, i) => ({
    id: i,
    type,
    name,
    url: "",
    count: 0,
  })) as Tag[];
}

export function recommendationLibRowToBook(row: RecommendationLibBatchRow): Book {
  const id = Number(row.book_id);
  const mediaId = parsePositiveId(row.media_id);
  const thumb = thumbUrlForRecommendationRow(row);
  const uploaded =
    row.uploaded_at != null
      ? new Date(String(row.uploaded_at)).toISOString()
      : "";

  const tagsAll = row.tags ?? [];
  const tagObjs = toDisplayTags(tagsAll, "tag");

  return {
    id,
    title: {
      english: row.title_english ?? "",
      japanese: row.title_japanese ?? "",
      pretty: row.title_pretty ?? row.title_english ?? "",
    },
    uploaded,
    media: mediaId ?? 0,
    favorites: 0,
    pagesCount: Number(row.pages ?? 0),
    scanlator: "",
    tags: tagObjs,
    cover: thumb,
    coverW: 0,
    coverH: 0,
    thumbnail: thumb,
    pages: [],
    artists: toDisplayTags(jsonStringArray(row.artists), "artist"),
    characters: toDisplayTags(jsonStringArray(row.characters), "character"),
    parodies: toDisplayTags(jsonStringArray(row.parodies), "parody"),
    groups: toDisplayTags(jsonStringArray(row.groups), "group"),
    categories: toDisplayTags(jsonStringArray(row.categories), "category"),
    languages: toDisplayTags(jsonStringArray(row.languages), "language"),
    tagIds: [],
  } as Book;
}

function minimalPlaceholderBook(id: number): Book {
  return {
    id,
    title: { english: `#${id}`, japanese: "", pretty: `#${id}` },
    uploaded: "",
    media: 0,
    favorites: 0,
    pagesCount: 0,
    scanlator: "",
    tags: [],
    cover: "",
    coverW: 0,
    coverH: 0,
    thumbnail: "",
    pages: [],
    artists: [],
    characters: [],
    parodies: [],
    groups: [],
    categories: [],
    languages: [],
    tagIds: [],
  } as Book;
}

const BATCH_CHUNK = 200;

/** Параллельных GET /galleries/:id при догрузке обложек (остальное — batch из PostgreSQL). */
const THUMB_HYDRATE_CONCURRENCY = 6;

function mergeThumbFromLiveGallery(base: Book, live: Book): Book {
  const thumb = live.thumbnail?.trim();
  const cover = live.cover?.trim();
  if (!thumb && !cover) return base;
  return {
    ...base,
    media: live.media || base.media,
    cover: cover || base.cover,
    thumbnail: thumb || base.thumbnail,
    coverW: live.coverW || base.coverW,
    coverH: live.coverH || base.coverH,
  };
}

/**
 * Если в recommendation-lib нет media_id, обложки пустые — запрашиваем GET /api/v2/galleries/:id
 * и подставляем thumb/cover (как у обычного просмотра книги).
 */
export async function hydrateMissingThumbnails(books: Book[]): Promise<Book[]> {
  const needIdx: number[] = [];
  for (let i = 0; i < books.length; i++) {
    if (!books[i].thumbnail?.trim()) needIdx.push(i);
  }
  if (needIdx.length === 0) return books;

  const copy = books.slice();
  for (let i = 0; i < needIdx.length; i += THUMB_HYDRATE_CONCURRENCY) {
    const batch = needIdx.slice(i, i + THUMB_HYDRATE_CONCURRENCY);
    await Promise.all(
      batch.map(async (idx) => {
        const id = copy[idx].id;
        if (!Number.isFinite(id) || id <= 0) return;
        try {
          const g = await getGallery(id);
          const live = galleryToBook(g);
          copy[idx] = mergeThumbFromLiveGallery(copy[idx], live);
        } catch {
          /* оставляем как есть */
        }
      })
    );
  }
  return copy;
}

/**
 * Preserves first occurrence order, dedupes.
 */
function uniqueOrdered(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    const id = Math.floor(Number(raw));
    if (!Number.isFinite(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type FetchRecommendationOptions = {
  /** Карточки для id, которых ещё нет в БД (ещё не отсканированы) */
  placeholdersForMissing?: boolean;
};

/**
 * Загружает книги одним (или несколькими chunked) запросами к nhapp-api.
 * Порядок совпадает с `ids` (с дедупликацией подряд).
 */
export async function fetchBooksFromRecommendationLib(
  idsOrdered: number[],
  opts?: FetchRecommendationOptions
): Promise<Book[]> {
  const ordered = uniqueOrdered(idsOrdered);
  if (ordered.length === 0) return [];
  await initCdn();
  const base = nhappApiBase();
  const placeholders = opts?.placeholdersForMissing === true;
  const out: Book[] = [];

  for (let i = 0; i < ordered.length; i += BATCH_CHUNK) {
    const chunk = ordered.slice(i, i + BATCH_CHUNK);
    const q = chunk.join(",");
    const url = `${base}/api/recommendation-lib/books/batch?q=${encodeURIComponent(q)}`;
    // Backend returns `{ books: recommendation_lib rows, missing: number[] }`.
    // Older code expected `{ books: RecommendationLibBatchRow[] }` — normalize both.
    const data = await fetchJsonCompat<{
      books?: any[];
      missing?: number[];
    }>(url);
    const byId = new Map<number, Book>();
    const normalizeRow = (row: any): RecommendationLibBatchRow => ({
      book_id: row?.book_id ?? row?.bookId ?? row?.id,
      media_id: row?.media_id ?? row?.mediaId ?? null,
      title_english: row?.title_english ?? row?.titleEnglish ?? null,
      title_japanese: row?.title_japanese ?? row?.titleJapanese ?? null,
      title_pretty: row?.title_pretty ?? row?.titlePretty ?? null,
      parodies: row?.parodies ?? [],
      characters: row?.characters ?? [],
      artists: row?.artists ?? [],
      groups: row?.groups ?? [],
      languages: row?.languages ?? [],
      categories: row?.categories ?? [],
      pages: row?.pages ?? 0,
      uploaded_at: row?.uploaded_at ?? row?.uploadedAt ?? null,
      tags: row?.tags ?? [],
    });
    for (const raw of data.books ?? []) {
      const row = normalizeRow(raw);
      const b = recommendationLibRowToBook(row);
      byId.set(b.id, b);
    }
    for (const id of chunk) {
      const b = byId.get(id);
      if (b) out.push(b);
      else if (placeholders) out.push(minimalPlaceholderBook(id));
    }
  }
  return hydrateMissingThumbnails(out);
}

/**
 * Batch lookup of tag popularity (book counts in recommendation_lib) from nhapp-api.
 */
export async function fetchTagCountsLookup(
  names: string[]
): Promise<Map<string, number>> {
  const base = nhappApiBase();
  const unique = [
    ...new Set(names.map((n) => String(n).trim().toLowerCase()).filter(Boolean)),
  ];
  const map = new Map<string, number>();
  if (unique.length === 0) return map;

  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${base}/api/recommendation-lib/tag-counts/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: slice }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        tagCounts?: { tagName: string; count: number }[];
      };
      for (const row of data.tagCounts ?? []) {
        map.set(String(row.tagName).trim().toLowerCase(), row.count ?? 0);
      }
    } catch {
      /* offline / timeout */
    }
  }
  return map;
}
