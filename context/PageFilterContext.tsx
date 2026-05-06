import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Ctx = {
  pagesQuery: string;
  isHydrated: boolean;
  setPagesQuery: (next: string) => void;
  clearPagesQuery: () => void;
};

const STORAGE_KEY = "pagesFilterPref:v1";

const PageFilterContext = createContext<Ctx>({
  pagesQuery: "",
  isHydrated: false,
  setPagesQuery: () => {},
  clearPagesQuery: () => {},
});

export function PageFilterProvider({ children }: { children: React.ReactNode }) {
  const [pagesQuery, setPagesQueryState] = useState("");
  const [isHydrated, setHydrated] = useState(false);

  const load = useCallback(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => setPagesQueryState((raw ?? "").trim()))
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    load();
    const unsub = subscribeToStorageApplied(load);
    return unsub;
  }, [load]);

  const setPagesQuery = useCallback((next: string) => {
    const clean = next.trim();
    setPagesQueryState(clean);
    AsyncStorage.setItem(STORAGE_KEY, clean).catch(() => {});
    requestStoragePush();
  }, []);

  const clearPagesQuery = useCallback(() => {
    setPagesQuery("");
  }, [setPagesQuery]);

  const value = useMemo(
    () => ({ pagesQuery, isHydrated, setPagesQuery, clearPagesQuery }),
    [pagesQuery, isHydrated, setPagesQuery, clearPagesQuery]
  );
  if (!isHydrated) return null;
  return <PageFilterContext.Provider value={value}>{children}</PageFilterContext.Provider>;
}

export function usePageFilter() {
  return useContext(PageFilterContext);
}
