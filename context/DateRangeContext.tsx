import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type Ctx = {
  uploaded: string | null;
  customRangeLabel: string | null;
  /** Last applied custom range (ISO date strings) for pre-fill and re-apply */
  lastCustomFrom: string | null;
  lastCustomTo: string | null;
  isHydrated: boolean;
  setUploaded: (val: string | null, displayLabel?: string | null) => void;
  setLastCustomRange: (from: string, to: string) => void;
  /** Одновременно установить фильтр по датам и сохранённый диапазон (один persist — даты не сбрасываются). */
  setCustomRangeApplied: (
    rangeQuery: string,
    displayLabel: string,
    fromISO: string,
    toISO: string
  ) => void;
  clearLastCustomRange: () => void;
  clearUploaded: () => void;
};

const DateRangeContext = createContext<Ctx>({
  uploaded: null,
  customRangeLabel: null,
  lastCustomFrom: null,
  lastCustomTo: null,
  isHydrated: false,
  setUploaded: () => {},
  setLastCustomRange: () => {},
  setCustomRangeApplied: () => {},
  clearLastCustomRange: () => {},
  clearUploaded: () => {},
});

const STORAGE_KEY = "dateRange:v5";

function normalizeUploadedFilter(val: string | null | undefined): string | null {
  if (!val) return null;
  const v = String(val).trim();
  if (!v) return null;
  if (v.startsWith("uploaded:")) return v;
  if (/^[<>]=?\d+[hdmy]$/i.test(v)) return `uploaded:${v}`;
  return v;
}

export function DateRangeProvider({ children }: PropsWithChildren) {
  const [uploaded, setUploadedState] = useState<string | null>(null);
  const [customRangeLabel, setCustomRangeLabel] = useState<string | null>(null);
  const [lastCustomFrom, setLastCustomFromState] = useState<string | null>(null);
  const [lastCustomTo, setLastCustomToState] = useState<string | null>(null);
  const [isHydrated, setHydrated] = useState(false);

  const load = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          uploaded?: string | null;
          customRangeLabel?: string | null;
          lastCustomFrom?: string | null;
          lastCustomTo?: string | null;
        };
        setUploadedState(normalizeUploadedFilter(parsed?.uploaded));
        setCustomRangeLabel(parsed?.customRangeLabel ?? null);
        setLastCustomFromState(parsed?.lastCustomFrom ?? null);
        setLastCustomToState(parsed?.lastCustomTo ?? null);
      }
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeToStorageApplied(load);
    return unsub;
  }, [load]);

  const persist = useCallback(
    async (
      val: string | null,
      label: string | null,
      lastFrom: string | null,
      lastTo: string | null
    ) => {
      try {
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            uploaded: val,
            customRangeLabel: label,
            lastCustomFrom: lastFrom,
            lastCustomTo: lastTo,
          })
        );
        requestStoragePush();
      } catch {}
    },
    []
  );

  const setUploaded = useCallback(
    (val: string | null, displayLabel?: string | null) => {
      const normalized = normalizeUploadedFilter(val);
      setUploadedState(normalized);
      const nextLabel =
        normalized == null || !normalized.startsWith("uploaded:>")
          ? null
          : displayLabel !== undefined
            ? displayLabel
            : customRangeLabel;
      setCustomRangeLabel(nextLabel);
      void persist(normalized, nextLabel, lastCustomFrom, lastCustomTo);
    },
    [persist, customRangeLabel, lastCustomFrom, lastCustomTo]
  );

  const setLastCustomRange = useCallback(
    (from: string, to: string) => {
      setLastCustomFromState(from);
      setLastCustomToState(to);
      void persist(uploaded, customRangeLabel, from, to);
    },
    [persist, uploaded, customRangeLabel]
  );

  const setCustomRangeApplied = useCallback(
    (rangeQuery: string, displayLabel: string, fromISO: string, toISO: string) => {
      const normalized = normalizeUploadedFilter(rangeQuery);
      setUploadedState(normalized);
      setCustomRangeLabel(displayLabel);
      setLastCustomFromState(fromISO);
      setLastCustomToState(toISO);
      void persist(normalized, displayLabel, fromISO, toISO);
    },
    [persist]
  );

  const clearLastCustomRange = useCallback(() => {
    setLastCustomFromState(null);
    setLastCustomToState(null);
    void persist(uploaded, customRangeLabel, null, null);
  }, [persist, uploaded, customRangeLabel]);

  const clearUploaded = useCallback(() => setUploaded(null), [setUploaded]);

  const value = useMemo(
    () => ({
      uploaded,
      customRangeLabel,
      lastCustomFrom,
      lastCustomTo,
      isHydrated,
      setUploaded,
      setLastCustomRange,
      setCustomRangeApplied,
      clearLastCustomRange,
      clearUploaded,
    }),
    [
      uploaded,
      customRangeLabel,
      lastCustomFrom,
      lastCustomTo,
      isHydrated,
      setUploaded,
      setLastCustomRange,
      setCustomRangeApplied,
      clearLastCustomRange,
      clearUploaded,
    ]
  );

  return (
    <DateRangeContext.Provider value={value}>
      {children}
    </DateRangeContext.Provider>
  );
}

export const useDateRange = () => useContext(DateRangeContext);
