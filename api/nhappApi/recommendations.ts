/**
 * Client-side recommendation engine.
 *
 * Signals used to build the preference profile:
 *   1. tag.favs.v1         — explicitly starred tags          (weight ×10)
 *   2. bookFavorites        — local favorites metadata         (weight ×3)
 *   3. bookFavoritesOnline  — cloud favorites metadata         (weight ×2)
 *   4. readHistory          — recently read books              (weight ×2–3)
 *   5. searchHistory        — free-text queries (weighted, recency-boosted);
 *                            dedicated API queries use `search` (title match)
 *   6. Page-count preference — short / medium / long / mixed
 *   7. Year preference       — preferred upload-year ranges
 *
 * Refresh diversity:
 *   _refreshCount increments on every clearRecommendationCache() call.
 *   Each query uses a different API page offset derived from _refreshCount,
 *   so consecutive refreshes surface different books for the same signals.
 *   _shownBookIds tracks books already presented; they are excluded from
 *   the next generation (reset after 2 000 entries to avoid over-filtering).
 *
 * Exploration:
 *   With at least one signal, explore-queries mix extra slices from the library.
 *   Cold start (no favorites, history, searches, or tag signals): no feed — UI prompts
 *   the user to search, favorite, or read first.
 */

import type { Book } from "@/api/nhappApi/types";
import {
  fetchTagCountsLookup,
  hydrateMissingThumbnails,
  nhappApiBase,
  recommendationLibRowToBook,
  type RecommendationLibBatchRow,
} from "@/api/nhappApi/recommendationLib";
import { initCdn } from "@/api/v2";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getBlacklistStateCached } from "@/lib/blacklistFilter";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScoredTerm {
  name: string;
  score: number;
  sources: string[];
}

/** Raw tag signal + library popularity — used for live slider preview in settings modal. */
export interface TagCalibrationPreviewRow {
  name: string;
  rawScore: number;
  /** Books in nhapp recommendation_lib with this tag (1 if unknown). */
  popularity: number;
  sources: string[];
}

export interface PagePreference {
  avg: number;
  stddev: number;
  /** Inclusive lower bound of the preferred range. */
  minPreferred: number;
  /** Inclusive upper bound of the preferred range. */
  maxPreferred: number;
  /** Human-readable tendency. */
  label: "short" | "medium" | "long" | "mixed";
  sampleCount: number;
}

export interface YearPreference {
  /** Up to 3 top years, sorted by frequency desc. */
  topYears: number[];
  /** year → book-count from favorites/history. */
  yearCounts: Record<number, number>;
}

export interface RecommendationProfile {
  tags: ScoredTerm[];
  artists: ScoredTerm[];
  parodies: ScoredTerm[];
  characters: ScoredTerm[];
  groups: ScoredTerm[];
  languages: string[];
  pagePreference: PagePreference | null;
  yearPreference: YearPreference | null;
  /** Every ID the user has already interacted with — excluded from results. */
  seenIds: Set<number>;
  // ── Stats for "How it works" modal ───────────────────────────────────────
  totalLocalFavorites: number;
  totalOnlineFavorites: number;
  totalReadHistory: number;
  totalTagFavs: number;
  totalSearchHistory: number;
  /** Recent unique search strings used for `search=` title queries (newest first). */
  searchQueriesForApi: string[];
  /** Tag rows before popularity calibration — for live preview when moving the slider. */
  tagCalibrationPreview?: TagCalibrationPreviewRow[];
}

export interface RecommendationResult {
  books: Book[];
  profile: RecommendationProfile;
  queriesUsed: string[];
  scoreById: Record<number, number>;
  maxScore: number;
  /** Which refresh generation produced this result. */
  refreshGeneration: number;
  generatedAt: number;
  /** Active include/exclude tag filters applied during generation. */
  filterIncludes: ActiveFilter[];
  filterExcludes: ActiveFilter[];
}

// ─── Module-level state ───────────────────────────────────────────────────────

let _cache: RecommendationResult | null = null;
/** Increments on every user-initiated refresh. */
let _refreshCount = 0;

/** Inclusive upper bound for the per-session recommendation seed (13 nines). */
const RECOMMENDATION_SESSION_SEED_MAX = 9_999_999_999_999;

/**
 * Random seed generated once per app session, uniform in [0, RECOMMENDATION_SESSION_SEED_MAX].
 * Combined with refresh/query index it rotates API page offsets so different sessions get
 * different book pools even when the preference profile is identical.
 */
const _sessionSeed = Math.floor(
  Math.random() * (RECOMMENDATION_SESSION_SEED_MAX + 1)
);

/** Page rotation for unfiltered discovery queries (large shared catalog). */
const DISCOVERY_PAGE_MOD = 400;

/**
 * IDs that were already shown to the user.
 * Cleared automatically when it grows too large.
 */
let _shownBookIds = new Set<number>();

export function clearRecommendationCache(): void {
  _cache = null;
  _refreshCount++;
  // Reset the seen-set after a few generations to avoid starving the pool
  if (_shownBookIds.size > 2_000) _shownBookIds = new Set();
}

/** Full reset after logout so the next login does not reuse another account’s signals. */
export function resetRecommendationStateForNewUser(): void {
  _cache = null;
  _refreshCount = 0;
  _shownBookIds = new Set();
}

export function getCachedRecommendations(): RecommendationResult | null {
  return _cache;
}

// ─── Score-map helpers ────────────────────────────────────────────────────────

type ScoreMap = Map<string, { score: number; sources: Set<string> }>;

function addScore(
  map: ScoreMap,
  rawName: string,
  score: number,
  source: string
): void {
  const key = rawName.trim().toLowerCase();
  if (!key) return;
  const entry = map.get(key);
  if (entry) {
    entry.score += score;
    entry.sources.add(source);
  } else {
    map.set(key, { score, sources: new Set([source]) });
  }
}

function mapToSorted(map: ScoreMap): ScoredTerm[] {
  return Array.from(map.entries())
    .map(([name, { score, sources }]) => ({ name, score, sources: [...sources] }))
    .sort((a, b) => b.score - a.score);
}

const TAG_POPULARITY_CALIBRATION_KEY = "recommendation.tagPopularityCalibration.v1";

/**
 * 0 = downweight tags that appear on many books in the library (less “big tag” dominance).
 * 100 = use raw accumulated scores (legacy behavior).
 */
export async function readTagPopularityCalibration(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(TAG_POPULARITY_CALIBRATION_KEY);
    if (raw == null) return 100;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, n));
  } catch {
    return 100;
  }
}

export async function writeTagPopularityCalibration(n: number): Promise<void> {
  const v = Math.max(0, Math.min(100, Math.round(n)));
  await AsyncStorage.setItem(TAG_POPULARITY_CALIBRATION_KEY, String(v));
}

/**
 * score = raw / pop^(1−α), α = calibration/100 (linear slider).
 * α=0 → score = raw/pop (strong penalty for globally common tags; niche rises in ranking).
 * α=1 → pop^0 = 1 → score = raw (popularity ignored).
 * Unlike blending 1/pop with (1−1/pop)×α, this differentiates every tag at every α — otherwise
 * w≈α for all huge pops and order barely moved away from raw counts.
 */
export function tagPopularityMultiplier(
  popularity: number,
  calibration: number
): number {
  const pop = Math.max(1, popularity);
  const alpha = Math.max(0, Math.min(1, calibration / 100));
  return 1 / Math.pow(pop, 1 - alpha);
}

function applyTagPopularityCalibration(
  tagScores: ScoreMap,
  counts: Map<string, number>,
  calibration: number
): void {
  for (const [key, entry] of tagScores) {
    const pop = Math.max(1, counts.get(key) ?? 1);
    entry.score *= tagPopularityMultiplier(pop, calibration);
  }
}

/** Same as `applyTagPopularityCalibration`, for UI preview (slider). */
export function previewTagCalibrationScore(
  rawScore: number,
  popularity: number,
  calibration: number
): number {
  const pop = Math.max(1, popularity);
  return rawScore * tagPopularityMultiplier(pop, calibration);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function yearFromUploadedAt(uploaded: string | null | undefined): number | null {
  if (!uploaded) return null;
  try {
    const y = new Date(uploaded).getUTCFullYear();
    return y >= 2000 && y <= new Date().getUTCFullYear() + 1 ? y : null;
  } catch {
    return null;
  }
}

// ─── Page-preference computation ─────────────────────────────────────────────

function computePagePreference(pageCounts: number[]): PagePreference | null {
  const valid = pageCounts.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length < 3) return null;

  const avg = valid.reduce((s, n) => s + n, 0) / valid.length;
  const variance =
    valid.reduce((s, n) => s + (n - avg) ** 2, 0) / valid.length;
  const stddev = Math.sqrt(variance);

  const minPreferred = Math.max(1, Math.round(avg - stddev));
  const maxPreferred = Math.round(avg + stddev);

  let label: PagePreference["label"];
  if (stddev > 40) label = "mixed";
  else if (avg < 25) label = "short";
  else if (avg > 80) label = "long";
  else label = "medium";

  return {
    avg: Math.round(avg),
    stddev: Math.round(stddev),
    minPreferred,
    maxPreferred,
    label,
    sampleCount: valid.length,
  };
}

// ─── Batch metadata fetch ─────────────────────────────────────────────────────

async function fetchMetadataBatch(
  ids: number[]
): Promise<RecommendationLibBatchRow[]> {
  if (ids.length === 0) return [];
  const base = nhappApiBase();
  const CHUNK = 200;
  const rows: RecommendationLibBatchRow[] = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const res = await fetch(
        `${base}/api/recommendation-lib/books/batch?q=${encodeURIComponent(
          chunk.join(",")
        )}`
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { books: RecommendationLibBatchRow[] };
      rows.push(...(data.books ?? []));
    } catch {
      /* skip */
    }
  }
  return rows;
}

// ─── Profile builder ──────────────────────────────────────────────────────────

type ReadHistoryEntry = [number, number, number, number];

export async function buildRecommendationProfile(): Promise<RecommendationProfile> {
  const [
    rawLocalFavs,
    rawOnlineFavs,
    rawReadHistory,
    rawSearchHistory,
    rawTagFavs,
    rawTagFavsLegacy,
  ] = await Promise.all([
    AsyncStorage.getItem("bookFavorites"),
    AsyncStorage.getItem("bookFavoritesOnline.v1"),
    AsyncStorage.getItem("readHistory"),
    AsyncStorage.getItem("searchHistory"),
    AsyncStorage.getItem("tag.favs.v1"),
    AsyncStorage.getItem("tag.favs"),
  ]);

  const localFavIds: number[] = rawLocalFavs ? JSON.parse(rawLocalFavs) : [];
  const onlineFavIds: number[] = rawOnlineFavs ? JSON.parse(rawOnlineFavs) : [];
  const readHistory: ReadHistoryEntry[] = rawReadHistory
    ? JSON.parse(rawReadHistory)
    : [];
  const searchHistory: string[] = rawSearchHistory
    ? JSON.parse(rawSearchHistory)
    : [];
  const tagFavObj: Record<string, true> = rawTagFavs
    ? JSON.parse(rawTagFavs)
    : rawTagFavsLegacy
    ? JSON.parse(rawTagFavsLegacy)
    : {};

  const localFavSet = new Set(localFavIds);
  const seenIds = new Set<number>([
    ...localFavIds,
    ...onlineFavIds,
    ...readHistory.map((e) => e[0]),
  ]);

  const tagScores: ScoreMap = new Map();
  const artistScores: ScoreMap = new Map();
  const parodyScores: ScoreMap = new Map();
  const characterScores: ScoreMap = new Map();
  const groupScores: ScoreMap = new Map();
  const langCount = new Map<string, number>();
  const pageCounts: number[] = [];
  const yearCount = new Map<number, number>();

  // ── Signal 1: Explicit tag favorites ──────────────────────────────────────
  let totalTagFavs = 0;
  for (const key of Object.keys(tagFavObj)) {
    const colon = key.indexOf(":");
    if (colon === -1) continue;
    const kind = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (!name) continue;
    totalTagFavs++;
    if (kind === "tags") addScore(tagScores, name, 10, "tagFavs");
    else if (kind === "artists") addScore(artistScores, name, 10, "tagFavs");
    else if (kind === "parodies") addScore(parodyScores, name, 10, "tagFavs");
    else if (kind === "characters") addScore(characterScores, name, 10, "tagFavs");
    else if (kind === "groups") addScore(groupScores, name, 10, "tagFavs");
  }

  // ── Signals 2–4: Batch metadata for recently interacted books ─────────────
  const recentLocalIds = localFavIds.slice(-150).reverse();
  const onlineOnlyIds = onlineFavIds
    .filter((id) => !localFavSet.has(id))
    .slice(-80)
    .reverse();
  const recentReadHistory = readHistory
    .slice()
    .sort((a, b) => b[3] - a[3])
    .slice(0, 60);
  const recentReadIds = recentReadHistory.map((e) => e[0]);

  const [localRows, onlineRows, readRows] = await Promise.all([
    fetchMetadataBatch(recentLocalIds),
    fetchMetadataBatch(onlineOnlyIds),
    fetchMetadataBatch(recentReadIds),
  ]);

  function processRow(
    row: RecommendationLibBatchRow,
    weight: number,
    source: string
  ): void {
    for (const t of row.tags ?? []) addScore(tagScores, t, weight, source);
    for (const a of parseArr(row.artists)) addScore(artistScores, a, weight, source);
    for (const p of parseArr(row.parodies)) addScore(parodyScores, p, weight, source);
    for (const c of parseArr(row.characters))
      addScore(characterScores, c, weight * 0.7, source);
    for (const g of parseArr(row.groups))
      addScore(groupScores, g, weight * 0.7, source);
    for (const l of parseArr(row.languages))
      langCount.set(l, (langCount.get(l) ?? 0) + 1);

    // Page count
    const pages = Number(row.pages);
    if (Number.isFinite(pages) && pages > 0) pageCounts.push(pages);

    // Year from uploaded_at
    const year = yearFromUploadedAt(row.uploaded_at ?? null);
    if (year) yearCount.set(year, (yearCount.get(year) ?? 0) + 1);
  }

  for (const row of localRows) processRow(row, 3, "localFavorites");
  for (const row of onlineRows) processRow(row, 2, "onlineFavorites");

  const now = Date.now();
  const readTsById = new Map(recentReadHistory.map((e) => [e[0], e[3]]));
  for (const row of readRows) {
    const ts = readTsById.get(Number(row.book_id)) ?? 0;
    const recent = now - ts < 7 * 24 * 3_600_000;
    processRow(row, recent ? 3 : 2, "readHistory");
  }

  // ── Signal 5: Search history (profile scores + title-search query list) ─────
  const searchQueriesForApi: string[] = [];
  const seenSearch = new Set<string>();
  for (const raw of searchHistory) {
    const trimmed = raw.trim();
    if (trimmed.length < 2) continue;
    const key = trimmed.toLowerCase();
    if (seenSearch.has(key)) continue;
    seenSearch.add(key);
    searchQueriesForApi.push(trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed);
    if (searchQueriesForApi.length >= 24) break;
  }

  const recentSearch = searchHistory.slice(0, 28);
  for (let i = 0; i < recentSearch.length; i++) {
    const query = recentSearch[i];
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) continue;
    const recencyBoost = 1 + ((recentSearch.length - i) / recentSearch.length) * 1.8;
    const w = 2.5 * recencyBoost;
    addScore(tagScores, q, w, "searchHistory");
    addScore(artistScores, q, w * 0.65, "searchHistory");
    addScore(parodyScores, q, w * 0.65, "searchHistory");
    addScore(characterScores, q, w * 0.55, "searchHistory");
    addScore(groupScores, q, w * 0.55, "searchHistory");
  }

  let tagCalibrationPreview: TagCalibrationPreviewRow[] | undefined;
  const tagPopCalibration = await readTagPopularityCalibration();
  if (tagScores.size > 0) {
    const counts = await fetchTagCountsLookup([...tagScores.keys()]);
    tagCalibrationPreview = [];
    for (const [name, entry] of tagScores) {
      const pop = Math.max(1, counts.get(name) ?? 1);
      tagCalibrationPreview.push({
        name,
        rawScore: entry.score,
        popularity: pop,
        sources: [...entry.sources],
      });
    }
    applyTagPopularityCalibration(tagScores, counts, tagPopCalibration);
  }

  const languages = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  // ── Page preference ────────────────────────────────────────────────────────
  const pagePreference = computePagePreference(pageCounts);

  // ── Year preference ────────────────────────────────────────────────────────
  const yearEntries = [...yearCount.entries()].sort((a, b) => b[1] - a[1]);
  const yearPreference: YearPreference | null =
    yearEntries.length > 0
      ? {
          topYears: yearEntries.slice(0, 3).map(([y]) => y),
          yearCounts: Object.fromEntries(yearEntries),
        }
      : null;

  return {
    tags: mapToSorted(tagScores),
    artists: mapToSorted(artistScores),
    parodies: mapToSorted(parodyScores),
    characters: mapToSorted(characterScores),
    groups: mapToSorted(groupScores),
    languages,
    pagePreference,
    yearPreference,
    seenIds,
    totalLocalFavorites: localFavIds.length,
    totalOnlineFavorites: onlineFavIds.length,
    totalReadHistory: readHistory.length,
    totalTagFavs,
    totalSearchHistory: searchHistory.length,
    searchQueriesForApi,
    tagCalibrationPreview,
  };
}

// ─── Active tag-filter helpers ────────────────────────────────────────────────

/** Mirrors FilterItem from TagFilterContext — read from AsyncStorage key "globalTagFilter.v3". */
export interface ActiveFilter {
  type: string; // "tag" | "artist" | "parody" | "group" | "category" | "character" | "language"
  name: string;
  mode: "include" | "exclude";
}

async function loadActiveFilters(): Promise<ActiveFilter[]> {
  try {
    const raw = await AsyncStorage.getItem("globalTagFilter.v3");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Return the normalised string[] for the row field that corresponds to a
 * FilterItem type.  "tag" → row.tags (already string[]); all other types use
 * the jsonb `parseArr` helper.
 */
function rowFieldForType(
  row: RecommendationLibBatchRow,
  type: string
): string[] {
  switch (type) {
    case "tag":
      return (row.tags ?? []).map((t) => t.toLowerCase());
    case "artist":
      return parseArr(row.artists).map((v) => v.toLowerCase());
    case "parody":
      return parseArr(row.parodies).map((v) => v.toLowerCase());
    case "character":
      return parseArr(row.characters).map((v) => v.toLowerCase());
    case "group":
      return parseArr(row.groups).map((v) => v.toLowerCase());
    case "category":
      return parseArr(row.categories).map((v) => v.toLowerCase());
    case "language":
      return parseArr(row.languages).map((v) => v.toLowerCase());
    default:
      return [];
  }
}

/**
 * Maps a FilterItem type to the corresponding API query parameter name.
 * Returns null for unknown types.
 */
function filterTypeToApiParam(type: string): string | null {
  switch (type) {
    case "tag":       return "tags";
    case "artist":    return "artists";
    case "parody":    return "parodies";
    case "character": return "characters";
    case "group":     return "groups";
    case "category":  return "categories";
    case "language":  return "languages";
    default:          return null;
  }
}

/**
 * Returns true only if the row passes the EXCLUDED filters.
 *
 * Included filters are enforced server-side (via API query params) because the
 * list endpoint does NOT return `row.tags`, making client-side tag-include
 * checks always fail. Non-tag exclude filters (artist, language, etc.) DO work
 * client-side because those jsonb columns ARE present in list-endpoint rows.
 *
 * Tag exclusions are best-effort: they are checked only when `row.tags` is
 * actually populated (i.e. rows from the batch endpoint).
 */
function passesActiveFilters(
  row: RecommendationLibBatchRow,
  excludes: ActiveFilter[]
): boolean {
  for (const f of excludes) {
    const values = rowFieldForType(row, f.type);
    if (values.includes(f.name.toLowerCase())) return false;
  }
  return true;
}

function rowMatchesBlacklist(
  row: RecommendationLibBatchRow,
  blockedNames: Set<string>
): boolean {
  if (!blockedNames.size) return false;
  const hasBlocked = (arr: string[]) =>
    arr.some((v) => blockedNames.has(String(v).trim().toLowerCase()));
  return (
    hasBlocked((row.tags ?? []).map((v) => String(v))) ||
    hasBlocked(parseArr(row.artists)) ||
    hasBlocked(parseArr(row.parodies)) ||
    hasBlocked(parseArr(row.characters)) ||
    hasBlocked(parseArr(row.groups)) ||
    hasBlocked(parseArr(row.categories)) ||
    hasBlocked(parseArr(row.languages))
  );
}

/**
 * Builds a Record of API params representing all include filters.
 * Multiple values for the same field are joined with "," (API treats as AND).
 */
function buildIncludeApiParams(includes: ActiveFilter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of includes) {
    const key = filterTypeToApiParam(f.type);
    if (!key) continue;
    out[key] = out[key] ? `${out[key]},${f.name}` : f.name;
  }
  return out;
}

/**
 * Merges include-filter params into a query's own params.
 * If both have the same key (e.g. "tags"), the values are combined with ","
 * so the API enforces both as AND conditions.
 */
function mergeIncludeParams(
  queryParams: Record<string, string>,
  includeApiParams: Record<string, string>
): Record<string, string> {
  const merged = { ...queryParams };
  for (const [key, val] of Object.entries(includeApiParams)) {
    merged[key] = merged[key] ? `${merged[key]},${val}` : val;
  }
  return merged;
}

// ─── Seeded diversity helpers ───────────────────────────────────────────────

function createSessionRng(): () => number {
  const lo = Number(_sessionSeed % 4294967296);
  const hi = Number(Math.floor(_sessionSeed / 4294967296) % 4294967296);
  let state = (lo ^ hi ^ (_refreshCount * 2654435761)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Merge per-query candidate lists in round-robin order so one query cannot occupy
 * a contiguous block (e.g. all “one piece” then all “frieren”). Each list should
 * already be ordered by preference; it is shuffled before merging for extra variety.
 */
function interleaveRoundRobinIds(
  lists: number[][],
  maxLen: number,
  rng: () => number
): number[] {
  const nonEmpty = lists.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return [];
  const shuffledLists = nonEmpty.map((list) => shuffle(list, rng));
  const ptrs = shuffledLists.map(() => 0);
  const out: number[] = [];
  const seen = new Set<number>();

  while (out.length < maxLen) {
    let progressed = false;
    for (let i = 0; i < shuffledLists.length; i++) {
      while (ptrs[i] < shuffledLists[i].length) {
        const id = shuffledLists[i][ptrs[i]++];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        progressed = true;
        break;
      }
      if (out.length >= maxLen) break;
    }
    if (!progressed) break;
  }
  return out;
}

function pickRandomFromTopPool<T extends { name: string }>(
  terms: T[],
  take: number,
  poolMax: number,
  rng: () => number
): T[] {
  if (terms.length === 0 || take <= 0) return [];
  const pool = terms.slice(0, Math.min(poolMax, terms.length));
  return shuffle(pool, rng).slice(0, take);
}

/** Unfiltered browse: many pages exist; use a wide but bounded range. */
function discoveryPageUnfiltered(slot: number): string {
  const n = _sessionSeed + _refreshCount * 19 + slot * 23;
  return String((n % DISCOVERY_PAGE_MOD) + 1);
}

// ─── Query execution ──────────────────────────────────────────────────────────

interface QueryDef {
  label: string;
  params: Record<string, string>;
  termScore: number;
}

async function executeQuery(
  params: Record<string, string>
): Promise<RecommendationLibBatchRow[]> {
  const base = nhappApiBase();
  const qs = new URLSearchParams({
    limit: "50",
    order: "desc",
    sort_by: "uploaded_at",
    ...params,
  }).toString();
  try {
    const res = await fetch(`${base}/api/recommendation-lib/books?${qs}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { books: RecommendationLibBatchRow[] };
    return data.books ?? [];
  } catch {
    return [];
  }
}

/**
 * Compute the API page number for this query index.
 *
 * Three factors combined:
 *   - _sessionSeed  — random per app start / device (uniform 0…RECOMMENDATION_SESSION_SEED_MAX)
 *   - _refreshCount — increments on every pull-to-refresh, rotating the offset
 *   - queryIndex    — each query within one generation hits a different page
 *
 * Only pages 1–15 are used: for a tag/artist query, higher page numbers often
 * return no rows (the result set is not that large). The large session seed still
 * picks a different starting point in this 15-cycle per session.
 * Step 7 (coprime to 15) guarantees all 15 pages are visited before cycling.
 */
function queryPage(queryIndex: number): string {
  return String(((_sessionSeed + _refreshCount * 7 + queryIndex) % 15) + 1);
}

// ─── Relevance scoring ────────────────────────────────────────────────────────

interface ScoringCtx {
  tagMap: Map<string, number>;
  artistMap: Map<string, number>;
  parodyMap: Map<string, number>;
  charMap: Map<string, number>;
  groupMap: Map<string, number>;
  preferredLang: string | null;
  pagePref: PagePreference | null;
  preferredYearSet: Set<number>;
  /** Weight per year: topYears[0] → 3, [1] → 2, [2] → 1 */
  yearScores: Map<number, number>;
}

function buildScoringCtx(profile: RecommendationProfile): ScoringCtx {
  const yearScores = new Map<number, number>();
  (profile.yearPreference?.topYears ?? []).forEach((y, i) => {
    yearScores.set(y, 3 - i); // 3, 2, 1
  });

  return {
    tagMap: new Map(profile.tags.map((t) => [t.name, t.score])),
    artistMap: new Map(profile.artists.map((t) => [t.name, t.score])),
    parodyMap: new Map(profile.parodies.map((t) => [t.name, t.score])),
    charMap: new Map(profile.characters.map((t) => [t.name, t.score])),
    groupMap: new Map(profile.groups.map((t) => [t.name, t.score])),
    preferredLang: profile.languages[0] ?? null,
    pagePref: profile.pagePreference,
    preferredYearSet: new Set(profile.yearPreference?.topYears ?? []),
    yearScores,
  };
}

function computeAdditionalScore(
  row: RecommendationLibBatchRow,
  ctx: ScoringCtx
): number {
  let bonus = 0;

  // Tags (available only via batch endpoint)
  for (const t of row.tags ?? []) {
    const s = ctx.tagMap.get(t.toLowerCase());
    if (s) bonus += s * 0.3;
  }

  // Metadata fields (available in both endpoints)
  for (const a of parseArr(row.artists)) {
    const s = ctx.artistMap.get(a.toLowerCase());
    if (s) bonus += s * 0.5;
  }
  for (const p of parseArr(row.parodies)) {
    const s = ctx.parodyMap.get(p.toLowerCase());
    if (s) bonus += s * 0.5;
  }
  for (const c of parseArr(row.characters)) {
    const s = ctx.charMap.get(c.toLowerCase());
    if (s) bonus += s * 0.3;
  }
  for (const g of parseArr(row.groups)) {
    const s = ctx.groupMap.get(g.toLowerCase());
    if (s) bonus += s * 0.3;
  }

  // Language preference: +10% multiplier
  if (ctx.preferredLang) {
    if (parseArr(row.languages).includes(ctx.preferredLang)) bonus *= 1.1;
  }

  // Page-count preference: +15% if within preferred range
  if (ctx.pagePref) {
    const pages = Number(row.pages);
    if (
      Number.isFinite(pages) &&
      pages >= ctx.pagePref.minPreferred &&
      pages <= ctx.pagePref.maxPreferred
    ) {
      bonus *= 1.15;
    }
  }

  // Year preference: weighted additive bonus
  const year = yearFromUploadedAt(row.uploaded_at ?? null);
  if (year) {
    const ys = ctx.yearScores.get(year) ?? 0;
    bonus += ys;
  }

  return bonus;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateRecommendations(): Promise<RecommendationResult> {
  if (_cache) return _cache;

  await initCdn();
  const [rawProfile, activeFilters, blacklist] = await Promise.all([
    buildRecommendationProfile(),
    loadActiveFilters(),
    getBlacklistStateCached(),
  ]);
  const blockedNames = new Set(
    (blacklist.names ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  );
  const profile: RecommendationProfile = blockedNames.size
    ? {
        ...rawProfile,
        tags: rawProfile.tags.filter((x) => !blockedNames.has(x.name.toLowerCase())),
        artists: rawProfile.artists.filter((x) => !blockedNames.has(x.name.toLowerCase())),
        parodies: rawProfile.parodies.filter((x) => !blockedNames.has(x.name.toLowerCase())),
        characters: rawProfile.characters.filter((x) => !blockedNames.has(x.name.toLowerCase())),
        groups: rawProfile.groups.filter((x) => !blockedNames.has(x.name.toLowerCase())),
        languages: rawProfile.languages.filter((x) => !blockedNames.has(x.toLowerCase())),
        searchQueriesForApi: rawProfile.searchQueriesForApi.filter(
          (x) => !blockedNames.has(x.toLowerCase())
        ),
        tagCalibrationPreview: rawProfile.tagCalibrationPreview?.filter(
          (x) => !blockedNames.has(x.name.toLowerCase())
        ),
      }
    : rawProfile;
  const filterIncludes = activeFilters.filter((f) => f.mode === "include");
  const filterExcludes = activeFilters.filter((f) => f.mode === "exclude");

  const hasSignals =
    profile.tags.length > 0 ||
    profile.artists.length > 0 ||
    profile.parodies.length > 0 ||
    profile.characters.length > 0 ||
    profile.groups.length > 0 ||
    profile.searchQueriesForApi.length > 0;

  const rng = createSessionRng();

  // ── Page-range params for queries that benefit from filtering ─────────────
  const pageParams: Record<string, string> = {};
  if (profile.pagePreference && profile.pagePreference.label !== "mixed") {
    pageParams.min_pages = String(profile.pagePreference.minPreferred);
    pageParams.max_pages = String(profile.pagePreference.maxPreferred);
  }

  // ── Include-filter API params (enforced server-side on every query) ────────
  const includeApiParams = buildIncludeApiParams(filterIncludes);

  // ── Build query plan (personalized only; cold accounts get empty + UI CTA) ─
  const queryDefs: QueryDef[] = [];
  let qi = 0;

  if (!hasSignals) {
    const empty: RecommendationResult = {
      books: [],
      profile,
      queriesUsed: [],
      scoreById: {},
      maxScore: 0,
      refreshGeneration: _refreshCount,
      generatedAt: Date.now(),
      filterIncludes,
      filterExcludes,
    };
    _cache = empty;
    return empty;
  }

  for (const term of pickRandomFromTopPool(profile.tags, 6, 24, rng)) {
      queryDefs.push({
        label: `tag: "${term.name}"`,
        params: { tags: term.name, ...pageParams, page: queryPage(qi++) },
        termScore: term.score,
      });
    }

    for (const term of pickRandomFromTopPool(profile.artists, 4, 16, rng)) {
      queryDefs.push({
        label: `artist: "${term.name}"`,
        params: { artists: term.name, page: queryPage(qi++) },
        termScore: term.score * 1.5,
      });
    }

    for (const term of pickRandomFromTopPool(profile.parodies, 3, 12, rng)) {
      queryDefs.push({
        label: `parody: "${term.name}"`,
        params: { parodies: term.name, page: queryPage(qi++) },
        termScore: term.score * 1.5,
      });
    }

    for (const term of pickRandomFromTopPool(profile.characters, 4, 18, rng)) {
      queryDefs.push({
        label: `character: "${term.name}"`,
        params: { characters: term.name, page: queryPage(qi++) },
        termScore: term.score * 1.5,
      });
    }

    for (const term of pickRandomFromTopPool(profile.groups, 3, 14, rng)) {
      queryDefs.push({
        label: `group: "${term.name}"`,
        params: { groups: term.name, page: queryPage(qi++) },
        termScore: term.score * 1.5,
      });
    }

    const preferredLang = profile.languages[0];
    if (preferredLang) {
      queryDefs.push({
        label: `language: "${preferredLang}"`,
        params: { languages: preferredLang, page: queryPage(qi++) },
        termScore: 3.5,
      });
    }

    const searchPicks = shuffle([...profile.searchQueriesForApi], rng).slice(0, 8);
    for (const q of searchPicks) {
      queryDefs.push({
        label: `search: "${q.length > 48 ? `${q.slice(0, 48)}…` : q}"`,
        params: { search: q, page: queryPage(qi++) },
        termScore: 5,
      });
    }

    let s = 200;
    const explore = 0.42;
    queryDefs.push(
      {
        label: `explore: recent · ${discoveryPageUnfiltered(s)}`,
        params: { page: discoveryPageUnfiltered(s++) },
        termScore: explore,
      },
      {
        label: `explore: by id · ${discoveryPageUnfiltered(s)}`,
        params: { page: discoveryPageUnfiltered(s++), sort_by: "book_id" },
        termScore: explore * 0.95,
      },
      {
        label: `explore: mixed length · ${discoveryPageUnfiltered(s)}`,
        params: {
          page: discoveryPageUnfiltered(s++),
          min_pages: String(20 + Math.floor(rng() * 40)),
          max_pages: String(120 + Math.floor(rng() * 120)),
        },
        termScore: explore * 0.85,
      }
    );

  // ── Execute queries in parallel ────────────────────────────────────────────
  const queryResults = await Promise.all(
    queryDefs.map(async (def) => ({
      def,
      rows: await executeQuery(mergeIncludeParams(def.params, includeApiParams)),
    }))
  );

  // ── Accumulate per-book scores ─────────────────────────────────────────────
  const bookScores = new Map<number, number>();
  const bookRows = new Map<number, RecommendationLibBatchRow>();

  // Combined exclusion: interacted-with books + books shown in a previous session
  const excludeIds = new Set([...profile.seenIds, ..._shownBookIds]);

  for (const { def, rows } of queryResults) {
    for (const row of rows) {
      const id = Number(row.book_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (excludeIds.has(id)) continue;
      if (rowMatchesBlacklist(row, blockedNames)) continue;
      if (!passesActiveFilters(row, filterExcludes)) continue;

      bookScores.set(id, (bookScores.get(id) ?? 0) + def.termScore);
      if (!bookRows.has(id)) bookRows.set(id, row);
    }
  }

  // ── Final scoring: interleave by query source, then fill by global rank ─────
  const ctx = buildScoringCtx(profile);

  function finalScore(id: number, row: RecommendationLibBatchRow): number {
    return (bookScores.get(id) ?? 0) + computeAdditionalScore(row, ctx);
  }

  const perQueryIds: number[][] = queryResults.map(({ rows }) => {
    const ids: number[] = [];
    const seenLocal = new Set<number>();
    for (const row of rows) {
      const id = Number(row.book_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (excludeIds.has(id)) continue;
      if (rowMatchesBlacklist(row, blockedNames)) continue;
      if (!passesActiveFilters(row, filterExcludes)) continue;
      if (seenLocal.has(id)) continue;
      seenLocal.add(id);
      ids.push(id);
    }
    ids.sort((a, b) => {
      const ra = bookRows.get(a);
      const rb = bookRows.get(b);
      if (!ra || !rb) return 0;
      return finalScore(b, rb) - finalScore(a, ra);
    });
    return ids;
  });

  let orderedIds = interleaveRoundRobinIds(perQueryIds, 150, rng);
  const picked = new Set(orderedIds);

  const rankedGlobal = [...bookRows.entries()]
    .map(([id, row]) => ({
      id,
      row,
      score: finalScore(id, row),
    }))
    .sort((a, b) => b.score - a.score);

  for (const { id } of rankedGlobal) {
    if (orderedIds.length >= 150) break;
    if (picked.has(id)) continue;
    orderedIds.push(id);
    picked.add(id);
  }

  const scored = orderedIds.map((id) => {
    const row = bookRows.get(id)!;
    return { id, row, score: finalScore(id, row) };
  });

  const maxScore =
    scored.length > 0 ? Math.max(...scored.map((s) => s.score)) : 1;
  const scoreById: Record<number, number> = {};
  for (const { id, score } of scored) {
    scoreById[id] = score;
    _shownBookIds.add(id); // remember for next refresh
  }

  const rawBooks = scored.map(({ row }) =>
    recommendationLibRowToBook({ ...row, tags: row.tags ?? [] })
  );
  const books = await hydrateMissingThumbnails(rawBooks);

  const result: RecommendationResult = {
    books,
    profile,
    queriesUsed: queryDefs.map((d) => d.label),
    scoreById,
    maxScore,
    refreshGeneration: _refreshCount,
    generatedAt: Date.now(),
    filterIncludes,
    filterExcludes,
  };

  _cache = result;
  return result;
}
