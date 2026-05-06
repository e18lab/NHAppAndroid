import { requestStoragePush, subscribeToStorageApplied } from "@/api/nhappApi/cloudStorage";
import { initCdn } from "@/api/v2";
import { getAuthStorageReady } from "@/api/v2/client";
import { UIKIT_AS_HOME_KEY } from "@/components/settings/keys";
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Font from "expo-font";
import * as NavigationBar from "expo-navigation-bar";
import { Stack, usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Drawer } from "react-native-drawer-layout";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import "@/background/autoImport.task";
import { DrawerContext } from "@/components/DrawerContext";
import {
  ELECTRON_TITLE_BAR_HEIGHT,
  ElectronTitleBar,
} from "@/components/ElectronTitleBar";
import { OverlayPortalProvider } from "@/components/OverlayPortal";
import { SearchBar } from "@/components/SearchBar";
import SideMenu from "@/components/SideMenu";
import { ToastProvider } from "@/components/ToastProvider";
import DownloadProgressBanner from "@/components/DownloadProgressBanner";
import { getGridConfigMap } from "@/config/gridConfig";
import AutoImportProvider from "@/context/AutoImportProvider";
import { DateRangeProvider } from "@/context/DateRangeContext";
import { PageFilterProvider } from "@/context/PageFilterContext";
import { SearchContentProvider } from "@/context/SearchContentContext";
import { SortProvider } from "@/context/SortContext";
import { TagProvider } from "@/context/TagFilterContext";
import { TagLibraryProvider } from "@/context/TagLibraryContext";
import { TopBarActionProvider } from "@/context/TopBarActionContext";
import { isElectron } from "@/electron/bridge";
import { useCloudStorageSync } from "@/hooks/useCloudStorageSync";
import { ThemeProvider, useTheme } from "@/lib/ThemeContext";
import { I18nProvider } from "@/lib/i18n/I18nContext";
import { syncOnlineFavoritesFullOnLaunch } from "@/lib/onlineFavoritesStartupSync";
import { Platform } from "react-native";

import { enableFreeze, enableScreens } from "react-native-screens";
enableScreens(true);
enableFreeze(true);

const FS_KEY = "ui_fullscreen";

const TopChrome = React.memo(function TopChrome({ bg }: { bg: string }) {
  const insets = useSafeAreaInsets();
  return <View style={{ height: insets.top, backgroundColor: bg }} />;
});

function CloudStorageSync() {
  useCloudStorageSync();
  return null;
}

/** Сессия nhentai: полный обход /favorites при старте; без изменений — без записи и без лишних страниц. */
function OnlineFavoritesStartupSync() {
  React.useEffect(() => {
    void syncOnlineFavoritesFullOnLaunch();
  }, []);
  return null;
}

// Pre-fetch CDN servers so media URLs resolve correctly before first render
initCdn();

// Однократная миграция токенов из @v2. → @auth.v2. (исключает их из cloud sync)
void getAuthStorageReady();

const StatusBarController = React.memo(function StatusBarController({
  fullscreen,
  hasDimModal,
  bg,
}: {
  fullscreen: boolean;
  hasDimModal: boolean;
  bg: string;
}) {
  const effectiveBg = fullscreen || hasDimModal ? "transparent" : bg;
  return (
    <StatusBar
      hidden={fullscreen}
      translucent
      style="light"
      backgroundColor={effectiveBg}
    />
  );
});

function AppShell() {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const contentWrapperRef = React.useRef<View>(null);

  const isTablet = Math.min(width, height) >= 600;
  const isLandscape = width > height;
  const isTabletPermanent = isTablet && isLandscape;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hasDimModal, setHasDimModal] = useState(false);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const drawerCtxValue = useMemo(() => ({ openDrawer }), [openDrawer]);

  const [fullscreen, setFullscreen] = useState<boolean>(false);

  const [menuCollapsed, setMenuCollapsed] = useState(false);

  const drawerContentEl = useMemo(
    () => (
      <SideMenu
        closeDrawer={closeDrawer}
        fullscreen={fullscreen}
        isTabletPermanent={isTabletPermanent}
        collapsed={menuCollapsed}
        onToggleCollapsed={() => setMenuCollapsed((v) => !v)}
      />
    ),
    [closeDrawer, fullscreen, isTabletPermanent, menuCollapsed]
  );
  const renderDrawerContent = useCallback(() => drawerContentEl, [
    drawerContentEl,
  ]);

  useEffect(() => {
    (globalThis as any).__setFullscreen = (v: boolean) => setFullscreen(v);
    (globalThis as any).__setHasDimModal = (v: boolean) => setHasDimModal(v);
    return () => {
      delete (globalThis as any).__setFullscreen;
      delete (globalThis as any).__setHasDimModal;
    };
  }, []);

  useEffect(() => {
    const load = () => {
      // Desktop/Electron: never hide window chrome via mobile fullscreen setting.
      if (Platform.OS === "web" && isElectron()) {
        setFullscreen(false);
        return Promise.resolve();
      }
      return AsyncStorage.getItem(FS_KEY).then((raw) => {
        setFullscreen(raw === "true");
      });
    };
    load();
    const unsub = subscribeToStorageApplied(load);
    return unsub;
  }, []);

  const fullscreenPushSkipRef = React.useRef(true);
  useEffect(() => {
    if (Platform.OS === "web" && isElectron()) return;
    AsyncStorage.setItem(FS_KEY, fullscreen ? "true" : "false").catch(() => {});
    if (!fullscreenPushSkipRef.current) requestStoragePush();
    fullscreenPushSkipRef.current = false;
  }, [fullscreen]);

  useEffect(() => {
    if (Platform.OS === "web" && isElectron()) return;
    (async () => {
      try {
        if (fullscreen) {
          await Promise.all([
            NavigationBar.setVisibilityAsync("hidden"),
            NavigationBar.setButtonStyleAsync("light"),
          ]);
        } else {
          await Promise.all([
            NavigationBar.setVisibilityAsync("visible"),
            NavigationBar.setButtonStyleAsync("light"),
          ]);
        }
      } catch (e) {
        console.warn("[layout] expo-navigation-bar failed:", e);
      }
    })();
  }, [fullscreen]);

  const drawerWidth = isTabletPermanent ? (menuCollapsed ? 80 : 300) : 300;

  const showElectronTitleBar = !fullscreen && isElectron() && Platform.OS === "web";

  useEffect(() => {
    if (!showElectronTitleBar || Platform.OS !== "web") return;

    const setWebPadding = () => {
      if (contentWrapperRef.current) {
        const element = contentWrapperRef.current as any;
        const domNode = element?._domNode || element?.base || element;
        if (domNode && domNode.style) {
          domNode.style.paddingTop = `${ELECTRON_TITLE_BAR_HEIGHT}px`;
        }
      }
    };

    const timeout = setTimeout(setWebPadding, 100);
    return () => clearTimeout(timeout);
  }, [showElectronTitleBar]);

  return (
    <SafeAreaView
      edges={fullscreen ? [] : ["bottom"]}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      {showElectronTitleBar && <ElectronTitleBar />}
      {!fullscreen && !showElectronTitleBar && (
        <TopChrome bg={hasDimModal ? "transparent" : colors.searchBg} />
      )}

      <DrawerContext.Provider value={drawerCtxValue}>
        <OverlayPortalProvider>
          <StatusBarController
            fullscreen={fullscreen}
            hasDimModal={hasDimModal}
            bg={colors.searchBg}
          />

          <Drawer
            open={drawerOpen}
            onOpen={openDrawer}
            onClose={closeDrawer}
            drawerPosition="left"
            drawerStyle={{
              width: drawerWidth,
              backgroundColor: colors.menuBg,
              marginBottom: 0,
              ...(showElectronTitleBar &&
                Platform.OS === "web" && {
                  paddingTop: ELECTRON_TITLE_BAR_HEIGHT,
                }),
            }}
            drawerType="back"
            swipeEnabled={false}
            renderDrawerContent={renderDrawerContent}
          >
            <View
              ref={contentWrapperRef}
              style={{
                flex: 1,
                backgroundColor: colors.bg,
                ...(showElectronTitleBar &&
                  Platform.OS === "web" && {
                    paddingTop: ELECTRON_TITLE_BAR_HEIGHT,
                  }),
              }}
            >
              <AppContent />
            </View>
          </Drawer>
        </OverlayPortalProvider>
      </DrawerContext.Provider>
    </SafeAreaView>
  );
}

function AppContent() {
  const [gridReady, setGridReady] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    let alive = true;
    getGridConfigMap()
      .catch(() => {})
      .finally(() => {
        if (alive) setGridReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (pathname !== "/") return;
    let cancelled = false;
    AsyncStorage.getItem(UIKIT_AS_HOME_KEY).then((v) => {
      if (v === "true" && !cancelled) router.replace("/uikit");
    });
    return () => { cancelled = true; };
  }, [pathname, router]);

  const showSearchBar = useMemo(() => {
    const blocked = pathname === "/read" || pathname === "/search";
    return !blocked;
  }, [pathname]);

  if (!gridReady) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <TopBarActionProvider>
      <SearchContentProvider>
        {showSearchBar ? (
          <View style={{ backgroundColor: colors.searchBg }}>
            <SearchBar />
          </View>
        ) : null}

        {/* Global download progress banner (all screens) */}
        <DownloadProgressBanner
          topInset={insets.top}
          pressable={pathname !== "/downloaded"}
        />

        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { flex: 1, backgroundColor: colors.bg },
            animation: "simple_push",
            freezeOnBlur: true,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="search" />
          <Stack.Screen name="favorites" />
          <Stack.Screen name="favoritesOnline" />
          <Stack.Screen name="explore" />
          <Stack.Screen name="book/[id]" />
          <Stack.Screen name="profile/[id]/[slug]" />
          <Stack.Screen name="profile/[id]/edit" />
          <Stack.Screen name="read" />
          <Stack.Screen name="downloaded" />
          <Stack.Screen name="recommendations" />
          <Stack.Screen name="tags/index" />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="uikit" />
          <Stack.Screen name="whats-new" />
          <Stack.Screen name="+not-found" />
        </Stack>
      </SearchContentProvider>
    </TopBarActionProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, setFontsLoaded] = useState(!(Platform.OS === "web" && isElectron()));

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const style = document.createElement("style");
    style.setAttribute("data-hide-scrollbar", "1");
    style.textContent = `
      * { scrollbar-width: none; -ms-overflow-style: none; }
      *::-webkit-scrollbar { display: none; width: 0; height: 0; }
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  useEffect(() => {
    if (Platform.OS === "web" && isElectron()) {
      (async () => {
        try {
          const fontName = 'feather';
          let fontUrl = null;
          if (Feather.font && Feather.font.feather) {
            fontUrl = Feather.font.feather;
            if (typeof fontUrl === 'string' && !fontUrl.startsWith('http') && !fontUrl.startsWith('app://')) {
              const cleanPath = fontUrl.replace(/^(\.\/|\/)+/, '');
              fontUrl = `app://${cleanPath}`;
            }
          }
          if (!fontUrl) {
            fontUrl = 'app://assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Feather.ttf';
          }
          if (typeof fontUrl === 'string' && fontUrl.startsWith('app://')) {
            fontUrl = fontUrl.replace('app://', 'app://./');
          }
          console.log("[RootLayout] Loading Feather font from:", fontUrl);
          const style = document.createElement('style');
          style.textContent = `
            @font-face {
              font-family: '${fontName}';
              src: url('${fontUrl}') format('truetype');
              font-weight: normal;
              font-style: normal;
              font-display: swap;
            }
          `;
          document.head.appendChild(style);
          console.log("[RootLayout] Created @font-face for Feather font");
          try {
            const fontFace = new FontFace(fontName, `url(${fontUrl})`);
            await fontFace.load();
            // TS DOM typings differ across targets; guard + cast for web/electron.
            (document as any).fonts?.add?.(fontFace);
            console.log("[RootLayout] Feather font loaded and added to document.fonts");
            await document.fonts.ready;
            const isLoaded = document.fonts.check(`12px ${fontName}`);
            console.log("[RootLayout] Font check result:", isLoaded);
          } catch (fontError) {
            console.warn("[RootLayout] FontFace.load failed, font may load via CSS:", fontError);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          try {
            if (Feather.font && typeof Font.loadAsync === 'function') {
              await Font.loadAsync(Feather.font);
              console.log("[RootLayout] Feather font loaded via Font.loadAsync");
            } else {
              await Feather.loadFont();
              console.log("[RootLayout] Feather font loaded via Feather.loadFont");
            }
          } catch (e) {
            console.warn("[RootLayout] expo-font load failed, but @font-face should work:", e);
          }
          setFontsLoaded(true);
        } catch (error) {
          console.warn("[RootLayout] Failed to load Feather font:", error);
          setFontsLoaded(true);
        }
      })();
    }
  }, []);

  if (!fontsLoaded && Platform.OS === "web" && isElectron()) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <AutoImportProvider>
        <ThemeProvider>
          <ToastProvider>
            <I18nProvider>
              <DateRangeProvider>
                <SortProvider>
                  <PageFilterProvider>
                    <TagProvider>
                      <TagLibraryProvider>
                        <CloudStorageSync />
                        <OnlineFavoritesStartupSync />
                        <AppShell />
                      </TagLibraryProvider>
                    </TagProvider>
                  </PageFilterProvider>
                </SortProvider>
              </DateRangeProvider>
            </I18nProvider>
          </ToastProvider>
        </ThemeProvider>
      </AutoImportProvider>
    </SafeAreaProvider>
  );
}
