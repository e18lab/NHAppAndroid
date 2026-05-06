import type { Tag } from "@/api/nhappApi/types";
import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
const KEY = "globalTagFilter.v3";
export type TagMode = "include" | "exclude";
export interface FilterItem {
  type: Tag["type"];
  name: string;
  mode: TagMode;
  /** nhentai tag id — when set, browse can use /galleries/tagged (full page count). */
  id?: string | number;
}
type ModeMap = Record<string, TagMode>;
interface Ctx {
  filters: FilterItem[];
  cycle: (t: { type: string; name: string; id?: string | number }) => void;
  setMode: (
    t: { type: string; name: string; id?: string | number },
    mode: TagMode | null
  ) => void;
  clear: () => void;
  includes: FilterItem[];
  excludes: FilterItem[];
  filtersReady: boolean;
  lastChangedKey: string | null;
  epoch: number;
  modeOf: (type: string, name: string) => TagMode | undefined;
}
const TagCtx = createContext<Ctx>({
  filters: [],
  cycle: () => {},
  setMode: () => {},
  clear: () => {},
  includes: [],
  excludes: [],
  filtersReady: false,
  lastChangedKey: null,
  epoch: 0,
  modeOf: () => undefined,
});
export function useFilterTags() {
  return useContext(TagCtx);
}
const keyOf = (t: { type: string; name: string }) => `${t.type}:${t.name}`;
export function TagProvider({ children }: { children: React.ReactNode }) {
  const [filters, setFilters] = useState<FilterItem[]>([]);
  const [filtersReady, setFiltersReady] = useState(false);
  const [lastChangedKey, setLastChangedKey] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [modeMap, setModeMap] = useState<ModeMap>({});
  const modeMapRef = useRef(modeMap);
  useEffect(() => {
    modeMapRef.current = modeMap;
  }, [modeMap]);
  const includes = useMemo(
    () => filters.filter((f) => f.mode === "include"),
    [filters]
  );
  const excludes = useMemo(
    () => filters.filter((f) => f.mode === "exclude"),
    [filters]
  );
  const load = useCallback(() => {
    AsyncStorage.getItem(KEY)
      .then((j) => {
        if (!j) {
          setFilters((prev) => (prev.length === 0 ? prev : []));
          setModeMap((prev) => (Object.keys(prev).length === 0 ? prev : {}));
          return;
        }
        const arr = JSON.parse(j) as FilterItem[];
        const serialized = JSON.stringify(arr);
        setFilters((prev) => (JSON.stringify(prev) === serialized ? prev : arr));
        const mm: ModeMap = {};
        for (const f of arr) mm[keyOf(f)] = f.mode;
        setModeMap((prev) => (JSON.stringify(prev) === JSON.stringify(mm) ? prev : mm));
      })
      .finally(() => setFiltersReady(true));
  }, []);
  useEffect(() => {
    load();
    const unsub = subscribeToStorageApplied(load);
    return unsub;
  }, [load]);
  const saveTimer = useRef<ReturnType<typeof global.setTimeout> | null>(null);
  useEffect(() => {
    if (!filtersReady) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = global.setTimeout(() => {
      AsyncStorage.setItem(KEY, JSON.stringify(filters)).catch(() => {});
      requestStoragePush();
    }, 150);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [filters, filtersReady]);
  const modeOf = useCallback(
    (type: string, name: string) => modeMapRef.current[`${type}:${name}`],
    []
  );
  const cycle = useCallback((t: { type: string; name: string; id?: string | number }) => {
    const k = keyOf(t);
    setEpoch((e) => e + 1);
    setLastChangedKey(`${k}:${Date.now()}`);
    setFilters((prev) => {
      const idx = prev.findIndex((x) => x.type === t.type && x.name === t.name);
      if (idx === -1) {
        setModeMap((m) => ({ ...m, [k]: "include" }));
        return [...prev, { ...t, mode: "include" }];
      }
      const cur = prev[idx];
      if (cur.mode === "include") {
        setModeMap((m) => ({ ...m, [k]: "exclude" }));
        const next = prev.slice();
        next[idx] = { ...cur, mode: "exclude" };
        return next;
      }
      setModeMap((m) => {
        const n = { ...m };
        delete n[k];
        return n;
      });
      const cp = prev.slice();
      cp.splice(idx, 1);
      return cp;
    });
  }, []);
  const setMode = useCallback(
    (t: { type: string; name: string; id?: string | number }, mode: TagMode | null) => {
      const k = keyOf(t);
      setEpoch((e) => e + 1);
      setLastChangedKey(`${k}:${Date.now()}`);
      setFilters((prev) => {
        const idx = prev.findIndex((x) => x.type === t.type && x.name === t.name);
        if (mode == null) {
          if (idx === -1) return prev;
          const cp = prev.slice();
          cp.splice(idx, 1);
          return cp;
        }
        if (idx === -1) return [...prev, { ...t, mode }];
        const cur = prev[idx];
        if (cur.mode === mode && cur.id === t.id) return prev;
        const cp = prev.slice();
        cp[idx] = { ...cur, ...t, mode };
        return cp;
      });
      setModeMap((m) => {
        const n = { ...m };
        if (mode == null) delete n[k];
        else n[k] = mode;
        return n;
      });
    },
    []
  );
  const clear = useCallback(() => {
    setFilters([]);
    setModeMap({});
    setEpoch((e) => e + 1);
    setLastChangedKey(null);
  }, []);
  return (
    <TagCtx.Provider
      value={{
        filters,
        cycle,
        setMode,
        clear,
        includes,
        excludes,
        filtersReady,
        lastChangedKey,
        epoch,
        modeOf,
      }}
    >
      {children}
    </TagCtx.Provider>
  );
}
