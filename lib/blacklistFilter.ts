import type { Book } from "@/api/nhappApi/types";
import { getBlacklist, getBlacklistIds } from "@/api/v2";
import { useEffect, useMemo, useState } from "react";

type BlacklistCache = {
  ids: number[];
  names: string[];
};
type TagLike = { id: number; name?: string };

let cache: BlacklistCache | null = null;
let cacheAt = 0;
let inFlight: Promise<BlacklistCache> | null = null;
const listeners = new Set<() => void>();
const CACHE_TTL_MS = 60_000;

function notify() {
  for (const fn of listeners) fn();
}

export function setBlacklistCache(tags: TagLike[]): void {
  const safe = Array.isArray(tags) ? tags : [];
  cache = {
    ids: safe.map((t) => t?.id).filter((id): id is number => Number.isFinite(id)),
    names: safe
      .map((t) => String(t?.name || "").trim().toLowerCase())
      .filter(Boolean),
  };
  cacheAt = Date.now();
  inFlight = null;
  notify();
}

export async function refreshBlacklistCache(): Promise<void> {
  await loadBlacklist();
}

async function loadBlacklist(): Promise<BlacklistCache> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const ids = await getBlacklistIds();
        if (Array.isArray(ids) && ids.length) {
          cache = { ids, names: [] };
          cacheAt = Date.now();
          notify();
          return cache;
        }
      } catch {}

      try {
        const res = await getBlacklist();
        const tags = Array.isArray(res?.tags) ? res.tags : [];
        cache = {
          ids: tags.map((t) => t.id).filter((id) => Number.isFinite(id)),
          names: tags.map((t) => String(t.name || "").trim().toLowerCase()).filter(Boolean),
        };
        cacheAt = Date.now();
        notify();
        return cache;
      } catch {
        cache = { ids: [], names: [] };
        cacheAt = Date.now();
        notify();
        return cache;
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

export async function getBlacklistStateCached(): Promise<BlacklistCache> {
  return loadBlacklist();
}

export function useBlacklistState(): BlacklistCache {
  const [state, setState] = useState<BlacklistCache>(cache ?? { ids: [], names: [] });

  useEffect(() => {
    let alive = true;
    const sync = () => {
      if (!alive) return;
      setState(cache ?? { ids: [], names: [] });
    };
    listeners.add(sync);
    if (cache == null || Date.now() - cacheAt >= CACHE_TTL_MS) {
      void loadBlacklist();
    } else {
      sync();
    }
    return () => {
      alive = false;
      listeners.delete(sync);
    };
  }, []);

  return state;
}

function collectBookTagNames(book: Book): string[] {
  const names: string[] = [];
  const pushFrom = (arr?: { name?: string }[]) => {
    if (!Array.isArray(arr)) return;
    for (const t of arr) {
      const n = String(t?.name || "").trim().toLowerCase();
      if (n) names.push(n);
    }
  };
  pushFrom(book.tags);
  pushFrom(book.artists);
  pushFrom(book.characters);
  pushFrom(book.parodies);
  pushFrom(book.groups);
  pushFrom(book.categories);
  pushFrom(book.languages);
  return names;
}

export function isBookBlacklisted(
  book: Book,
  blockedIds: Set<number>,
  blockedNames?: Set<string>
): boolean {
  if (!blockedIds.size && !(blockedNames && blockedNames.size)) return false;
  const tagIds = collectBookTagIds(book);
  for (const id of tagIds) {
    if (blockedIds.has(id)) return true;
  }
  if (blockedNames && blockedNames.size) {
    const names = collectBookTagNames(book);
    for (const name of names) {
      if (blockedNames.has(name)) return true;
    }
  }
  return false;
}

export function useBlacklistSets(): { ids: Set<number>; names: Set<string> } {
  const state = useBlacklistState();
  return useMemo(
    () => ({
      ids: new Set(state.ids),
      names: new Set(state.names),
    }),
    [state.ids, state.names]
  );
}

export function useBlacklistSet(): Set<number> {
  const { ids } = useBlacklistSets();
  return ids;
}

export function useBlacklistNameSet(): Set<string> {
  const { names } = useBlacklistSets();
  return names;
}

function collectBookTagIds(book: Book): number[] {
  const ids: number[] = [];
  const pushFrom = (arr?: { id: number }[]) => {
    if (!Array.isArray(arr)) return;
    for (const t of arr) {
      if (t && Number.isFinite(t.id)) ids.push(t.id);
    }
  };

  pushFrom(book.tags);
  pushFrom(book.artists);
  pushFrom(book.characters);
  pushFrom(book.parodies);
  pushFrom(book.groups);
  pushFrom(book.categories);
  pushFrom(book.languages);
  if (Array.isArray(book.tagIds)) {
    for (const id of book.tagIds) {
      if (Number.isFinite(id)) ids.push(id);
    }
  }
  return ids;
}

