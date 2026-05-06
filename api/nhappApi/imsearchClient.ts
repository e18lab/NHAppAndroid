import type { Book } from "@/api/nhappApi/types";
import { API_BASE_URL } from "@/config/api";

export type ImsearchMatch = {
  galleryId: string;
  title?: string;
  score: number;
  imagePath?: string;
  previewImageUrl?: string;
  page?: number;
};

export type ImsearchSearchResult = {
  timeMs: number;
  matches: ImsearchMatch[];
};

function isWebFile(x: unknown): x is File {
  return typeof File !== "undefined" && x instanceof File;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetworkError(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e);
  if (/Network request failed/i.test(msg)) return true;
  if (/Failed to fetch/i.test(msg)) return true;
  if (/NetworkError|network error|ECONNRESET|ETIMEDOUT|ENOTFOUND|aborted/i.test(msg))
    return true;
  return false;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

const IMSEARCH_MAX_ATTEMPTS = 4;

async function postImsearchSearchMultipartOnce(
  file: File | { uri: string; name: string; type: string }
): Promise<ImsearchSearchResult> {
  const base = API_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/imsearch/search`;
  const fd = new FormData();
  if (isWebFile(file)) {
    fd.append("file", file);
  } else {
    fd.append("file", {
      uri: file.uri,
      name: file.name || "image.jpg",
      type: file.type || "image/jpeg",
    } as any);
  }
  const r = await fetch(url, { method: "POST", body: fd });
  const j = (await r.json().catch(() => ({}))) as ImsearchSearchResult & {
    error?: string;
    message?: string;
  };
  if (!r.ok) {
    const msg = j.message || j.error || `HTTP ${r.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return { timeMs: j.timeMs ?? 0, matches: Array.isArray(j.matches) ? j.matches : [] };
}

export async function postImsearchSearchMultipart(
  file: File | { uri: string; name: string; type: string }
): Promise<ImsearchSearchResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= IMSEARCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await postImsearchSearchMultipartOnce(file);
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number })?.status;
      const retriable =
        isTransientNetworkError(e) ||
        (typeof status === "number" && isTransientHttpStatus(status));
      if (attempt < IMSEARCH_MAX_ATTEMPTS && retriable) {
        await delay(350 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function imsearchMatchToBook(m: ImsearchMatch, idNum: number): Book {
  const thumb = String(m.previewImageUrl || "").trim();
  const pretty = String(m.title || `#${idNum}`).trim();
  const pagesFromMatch =
    typeof m.page === "number" && Number.isFinite(m.page) && m.page > 0 ? m.page : 0;
  return {
    id: idNum,
    title: {
      english: pretty,
      japanese: pretty,
      pretty,
    },
    uploaded: "",
    media: 0,
    favorites: 0,
    pagesCount: pagesFromMatch,
    scanlator: "",
    tags: [],
    cover: thumb || "",
    coverW: 0,
    coverH: 0,
    thumbnail: thumb || "",
    pages: [],
    artists: [],
    characters: [],
    parodies: [],
    groups: [],
    categories: [],
    languages: [],
    tagIds: [],
  } as unknown as Book;
}