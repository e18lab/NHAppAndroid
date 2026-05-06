import * as NavigationBar from "expo-navigation-bar";
import { setStatusBarHidden } from "expo-status-bar";
import React, { useMemo, useState } from "react";
import {
    Platform,
    Text,
    useWindowDimensions,
    View
} from "react-native";

import GridSection from "@/components/settings/GridSection";
import SettingsBuilder from "@/components/settings/SettingsBuilder";
import SettingsLayout from "@/components/settings/SettingsLayout";

import {
  FS_KEY,
  INFINITE_SCROLL_KEY,
  RESET_TAGS_ON_BOOK_TAG_NAV_KEY,
  RH_KEY,
  STORAGE_KEY_HUE,
} from "@/components/settings/keys";
import type { SettingsSection } from "@/components/settings/schema";
import { isElectron } from "@/electron/bridge";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";

import HuePaletteSelector from "@/components/settings/HuePaletteSelector";
import LanguageSelector from "@/components/settings/LanguageSelector";
import Section from "@/components/settings/Section";
import StorageManager from "@/components/settings/StorageManager";
import { SavePathRow } from "@/components/settings/rows/SavePathRow";
import { GridProfile } from "@/config/gridConfig";

function systemProfileForDims(w: number, h: number): GridProfile {
  const isLandscape = w > h;
  const isTablet = Math.min(w, h) >= 600;
  if (isTablet && isLandscape) return "tabletLandscape";
  if (isTablet && !isLandscape) return "tabletPortrait";
  if (!isTablet && isLandscape) return "phoneLandscape";
  return "phonePortrait";
}

export default function SettingsScreen() {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const sysProfile = systemProfileForDims(width, height);
  const [activeProfile, setActiveProfile] = useState<GridProfile>(sysProfile);
  const isDesktop = isElectron() || (Platform.OS === "web" && width >= 768);
  const isTablet = width >= 600 && width < 768;

  const { hue, setHue, colors } = useTheme();
  const [hueLocal, setHueLocal] = usePersistedState<number>(
    STORAGE_KEY_HUE,
    hue
  );
  const [fullscreen, setFullscreen] = usePersistedState<boolean>(FS_KEY, false, {
    syncToCloud: true,
  });
  const [infiniteScroll, setInfiniteScroll] = usePersistedState<boolean>(
    INFINITE_SCROLL_KEY,
    false,
    { syncToCloud: true }
  );
  const [resetTagsOnBookTagNav, setResetTagsOnBookTagNav] = usePersistedState<boolean>(
    RESET_TAGS_ON_BOOK_TAG_NAV_KEY,
    false,
    { syncToCloud: true }
  );
  const includeTagsOnBookTagNav = !resetTagsOnBookTagNav;

  const toggleFullscreen = async (value: boolean) => {
    setFullscreen(value);
    try {
      (globalThis as any).__setFullscreen?.(value);
    } catch {}
    try {
      setStatusBarHidden(value, "fade");
    } catch {}
    if (Platform.OS === "android") {
      try {
        if (value) {
          await NavigationBar.setVisibilityAsync("hidden");
          await NavigationBar.setButtonStyleAsync("light");
        } else {
          await NavigationBar.setVisibilityAsync("visible");
          await NavigationBar.setButtonStyleAsync("light");
        }
      } catch (e) {
        console.warn("[settings] expo-navigation-bar failed:", e);
      }
    }
  };

  const sections: SettingsSection[] = useMemo(
    () => {
      const electronMode = isElectron();
      const sectionsList: SettingsSection[] = [
        {
          id: "language",
          title: t("settings.section.language"),
          cards: [
            {
              id: "language-card",
              items: [
                {
                  id: "language-row",
                  kind: "custom",
                  render: () => <LanguageSelector />,
                },
              ],
            },
          ],
        },
        {
          id: "appearance",
          title: t("settings.section.appearance"),
          cards: [
            {
              id: "theme-card",
              items: [
                {
                  id: "hue-palette",
                  kind: "custom",
                  render: () => (
                    <>
                      <View style={{ marginBottom: 4 }}>
                        <Text
                          style={{
                            fontSize: isDesktop ? 19 : isTablet ? 18 : 17,
                            fontWeight: "800",
                            color: colors.txt,
                            lineHeight: isDesktop ? 26 : isTablet ? 25 : 24,
                            letterSpacing: isDesktop ? 0.4 : isTablet ? 0.35 : 0.3,
                          }}
                        >
                          {t("settings.appearance.theme")}
                        </Text>
                      </View>
                      <View style={{ marginTop: isDesktop ? 20 : isTablet ? 18 : 16 }}>
                        <HuePaletteSelector
                          value={hueLocal}
                          onValueChange={(deg) => setHueLocal(deg)}
                          onComplete={(deg) => setHue(deg)}
                        />
                      </View>
                    </>
                  ),
                },
                {
                  id: "infinite-scroll",
                  kind: "toggle",
                  title: t("settings.appearance.infiniteScroll") || "Бесконечная прокрутка",
                  description:
                    t("settings.appearance.infiniteScrollDesc") ||
                    "Автоматическая загрузка следующей страницы при прокрутке вниз вместо пагинации",
                  value: infiniteScroll,
                  onToggle: setInfiniteScroll,
                },
                {
                  id: "reset-tags-on-book-tag-nav",
                  kind: "toggle",
                  title:
                    t("settings.appearance.includeTagsOnBookTagNav") ||
                    "Учитывать теги при переходе по тегам в книге?",
                  description:
                    t("settings.appearance.includeTagsOnBookTagNavDesc") ||
                    "Если включено, переход по тегу из книги учитывает текущие фильтры. Если выключено — открывает поиск по тегу без текущих фильтров.",
                  value: includeTagsOnBookTagNav,
                  onToggle: (v) => setResetTagsOnBookTagNav(!v),
                },
              ],
            },
          ],
        },
      ];

      if (!electronMode) {
        sectionsList.push({
          id: "screen",
          title: t("settings.section.display"),
          cards: [
            {
              id: "screen-card",
              items: [
                {
                  id: "fullscreen",
                  kind: "toggle",
                  title: t("settings.display.fullscreen"),
                  description: t("settings.display.fullscreenDesc"),
                  value: fullscreen,
                  onToggle: toggleFullscreen,
                },
                {
                  id: "android-note",
                  kind: "custom",
                  render: () => (
                    <View
                      style={{
                        marginTop: isDesktop ? 18 : isTablet ? 16 : 14,
                        borderRadius: isDesktop ? 14 : isTablet ? 13 : 12,
                        borderWidth: 1,
                        paddingHorizontal: isDesktop ? 16 : isTablet ? 14 : 12,
                        paddingVertical: isDesktop ? 14 : isTablet ? 12 : 10,
                        borderColor: colors.accent + "30",
                        backgroundColor: colors.accent + "08",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: isDesktop ? 10 : isTablet ? 9 : 8,
                      }}
                    >
                      <Text style={{ 
                        fontSize: isDesktop ? 13 : isTablet ? 12.5 : 12, 
                        color: colors.sub, 
                        flex: 1, 
                        lineHeight: isDesktop ? 18 : isTablet ? 17 : 16 
                      }}>
                        {t("settings.display.androidNote")}
                      </Text>
                    </View>
                  ),
                },
              ],
            },
          ],
        });
      }


      return sectionsList;
    },
    [colors, fullscreen, hueLocal, infiniteScroll, includeTagsOnBookTagNav, t]
  );

  return (
    <SettingsLayout title={t("settings.title")}>
      <SettingsBuilder sections={sections} />

      <Section title={t("settings.section.grid")} />
      <GridSection
        activeProfile={activeProfile}
        setActiveProfile={setActiveProfile}
      />

      <Section title={t("settings.section.storage")} />
      {isElectron() && (
        <View style={{ 
          paddingHorizontal: isDesktop ? 0 : isTablet ? 0 : 0, 
          marginBottom: isDesktop ? 20 : isTablet ? 18 : 16 
        }}>
          <SavePathRow />
        </View>
      )}
      <StorageManager />
    </SettingsLayout>
  );
}
