/** Слияние облачного storage с локальным (см. nappi/src/lobby/storageMerge.ts). */

function parseIdArray(u: unknown): number[] {
  if (Array.isArray(u)) {
    return u.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof u === "string") {
    try {
      const j = JSON.parse(u) as unknown;
      return Array.isArray(j) ? j.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function mergeFavoriteIds(a: unknown, b: unknown): string {
  const s = new Set<number>();
  for (const x of parseIdArray(a)) s.add(x);
  for (const x of parseIdArray(b)) s.add(x);
  return JSON.stringify([...s].sort((x, y) => x - y));
}

type HistTuple = [number, number, number, number];

function parseReadHistory(u: unknown): Map<number, HistTuple> {
  const m = new Map<number, HistTuple>();
  const raw =
    typeof u === "string"
      ? (() => {
          try {
            return JSON.parse(u) as unknown;
          } catch {
            return null;
          }
        })()
      : u;
  if (!Array.isArray(raw)) return m;
  for (const e of raw) {
    if (!Array.isArray(e) || e.length < 4) continue;
    const id = Number(e[0]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const current = Math.max(0, Math.floor(Number(e[1]) || 0));
    const total = Math.max(1, Math.floor(Number(e[2]) || 1));
    const ts = Math.floor(Number(e[3]) || 0);
    m.set(id, [id, current, total, ts]);
  }
  return m;
}

export function mergeReadHistoryJson(a: unknown, b: unknown): string {
  const ma = parseReadHistory(a);
  const mb = parseReadHistory(b);
  const out = new Map(ma);
  for (const [id, br] of mb) {
    const ar = out.get(id);
    if (!ar) {
      out.set(id, br);
      continue;
    }
    const tsR = br[3];
    const tsA = ar[3];
    if (tsR > tsA) out.set(id, br);
    else if (tsR === tsA && br[1] > ar[1]) out.set(id, br);
  }
  return JSON.stringify([...out.values()]);
}

function parseSearchHistory(u: unknown): string[] {
  const raw =
    typeof u === "string"
      ? (() => {
          try {
            return JSON.parse(u) as unknown;
          } catch {
            return null;
          }
        })()
      : u;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

export function mergeSearchHistoryJson(a: unknown, b: unknown): string {
  const loc = parseSearchHistory(a);
  const rem = parseSearchHistory(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...loc, ...rem]) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= 40) break;
  }
  return JSON.stringify(out);
}

const MERGE_FAVORITE_KEYS = new Set(["bookFavorites", "bookFavoritesOnline.v1"]);

export function mergeValueForKey(key: string, localStr: string | null, remoteVal: unknown): string {
  if (MERGE_FAVORITE_KEYS.has(key)) {
    return mergeFavoriteIds(localStr, remoteVal);
  }
  if (key === "readHistory") {
    return mergeReadHistoryJson(localStr, remoteVal);
  }
  if (key === "searchHistory") {
    return mergeSearchHistoryJson(localStr, remoteVal);
  }
  return typeof remoteVal === "string" ? remoteVal : JSON.stringify(remoteVal);
}
