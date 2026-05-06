import { Feather } from "@expo/vector-icons";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
    Animated,
    Easing,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import {
    getLobbyConnectionSnap,
    getLobbyRole,
    subscribeToLobbyCloudStats,
    subscribeToLobbyPeersCount,
    subscribeToLobbyPeersDevices,
    subscribeToLobbyRole,
    type LobbyPeerDevice,
    type LobbyConnectionUi,
} from "@/api/nhappApi/lobbyStorage";
import { CalendarRangePicker } from "@/components/CalendarRangePicker";
import { useDrawer } from "@/components/DrawerContext";
import NhModal from "@/components/nhModal";
import type { SelectItem } from "@/components/uikit/FilterDropdown";
import { FilterDropdown } from "@/components/uikit/FilterDropdown";
import { useDateRange } from "@/context/DateRangeContext";
import { usePageFilter } from "@/context/PageFilterContext";
import { SortKey, useSort } from "@/context/SortContext";
import { useFilterTags } from "@/context/TagFilterContext";
import { useOnlineMe } from "@/hooks/useOnlineMe";
import { useBlacklistNameSet } from "@/lib/blacklistFilter";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";
import { useTopBarAction } from "@/context/TopBarActionContext";
import { getDeviceId } from "@/utils/deviceId";

const BAR_HEIGHT = 52;
const BTN_SIDE = 40;
const LANGUAGE_FILTER_KEYS = ["english", "japanese", "chinese", "translated"] as const;
const LANGUAGE_OPTIONS = ["english", "japanese", "chinese"] as const;
type LanguageOption = (typeof LANGUAGE_OPTIONS)[number];
type PagesMode = "eq" | "gt" | "lt" | "range";

function PagesFilterEditor({
  colors,
  t,
  initialQuery,
  onApply,
  onClear,
}: {
  colors: ReturnType<typeof useTheme>["colors"];
  t: (k: string) => string;
  initialQuery: string;
  onApply: (query: string) => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<PagesMode>("eq");
  const [v1, setV1] = useState("");
  const [v2, setV2] = useState("");

  useEffect(() => {
    const q = initialQuery.trim();
    const range = q.match(/^pages:>=?(\d+)\s+pages:<=?(\d+)$/i);
    if (range) {
      setMode("range");
      setV1(range[1] ?? "");
      setV2(range[2] ?? "");
      return;
    }
    const gt = q.match(/^pages:>(\d+)$/i);
    if (gt) {
      setMode("gt");
      setV1(gt[1] ?? "");
      setV2("");
      return;
    }
    const lt = q.match(/^pages:<(\d+)$/i);
    if (lt) {
      setMode("lt");
      setV1(lt[1] ?? "");
      setV2("");
      return;
    }
    const eq = q.match(/^pages:(\d+)$/i);
    if (eq) {
      setMode("eq");
      setV1(eq[1] ?? "");
      setV2("");
    }
  }, [initialQuery]);

  const toInt = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  return (
    <View style={styles.pagesWrap}>
      <View style={styles.pagesModeRow}>
        {([
          ["eq", "="],
          ["gt", ">"],
          ["lt", "<"],
          ["range", "↔"],
        ] as [PagesMode, string][]).map(([k, lbl]) => (
          <Pressable
            key={k}
            onPress={() => setMode(k)}
            style={[
              styles.pagesModeBtn,
              {
                borderColor: mode === k ? colors.accent : colors.page + "88",
              },
            ]}
          >
            <Text style={{ color: mode === k ? colors.accent : colors.sub, fontSize: 12, fontWeight: "700" }}>
              {lbl}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.pagesInputRow}>
        <TextInput
          value={v1}
          onChangeText={(x) => setV1(x.replace(/[^\d]/g, ""))}
          keyboardType="numeric"
          placeholder={t("explore.pages.input.primary") || "Pages"}
          placeholderTextColor={colors.sub}
          style={[styles.pagesInput, { color: colors.txt, borderColor: colors.page }]}
        />
        {mode === "range" ? (
          <TextInput
            value={v2}
            onChangeText={(x) => setV2(x.replace(/[^\d]/g, ""))}
            keyboardType="numeric"
            placeholder={t("explore.pages.input.secondary") || "To"}
            placeholderTextColor={colors.sub}
            style={[styles.pagesInput, { color: colors.txt, borderColor: colors.page }]}
          />
        ) : null}
      </View>
      <View style={styles.pagesActionRow}>
        <Pressable onPress={onClear}>
          <Text style={{ color: colors.sub, fontSize: 12, fontWeight: "700" }}>
            {t("common.reset")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            const a = toInt(v1);
            const b = toInt(v2);
            let next = "";
            if (mode === "eq" && a > 0) next = `pages:${a}`;
            if (mode === "gt" && a > 0) next = `pages:>${a}`;
            if (mode === "lt" && a > 0) next = `pages:<${a}`;
            if (mode === "range" && a > 0 && b > 0) {
              const lo = Math.min(a, b);
              const hi = Math.max(a, b);
              next = `pages:>=${lo} pages:<=${hi}`;
            }
            if (next) onApply(next);
          }}
          style={[styles.pagesApplyBtn, { borderColor: colors.accent }]}
        >
          <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "800" }}>{t("common.apply")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function hasSeg(pathname: string | null | undefined, seg: string) {
  const p = pathname ?? "";
  return new RegExp(`(^|/)${seg}(\\/|$)`).test(p);
}

function IconBtn({
  onPress,
  onLongPress,
  disabled,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconBtnRound,
        (pressed && !disabled) && { backgroundColor: colors.accent + "22" },
        disabled && { opacity: 0.6 },
      ]}
    >
      {children}
    </Pressable>
  );
}


export function SearchBar() {
  const { colors } = useTheme();
  const { openDrawer } = useDrawer();
  const { sort, setSort } = useSort();
  const { filters, setMode } = useFilterTags() as any;
  const blacklistNames = useBlacklistNameSet();
  const { pagesQuery, setPagesQuery, clearPagesQuery } = usePageFilter();
  const router = useRouter();
  const pathname = usePathname();
  const { action } = useTopBarAction();
  const {
    uploaded,
    customRangeLabel,
    lastCustomFrom,
    lastCustomTo,
    setUploaded,
    setCustomRangeApplied,
    clearUploaded,
  } = useDateRange();
  const { t } = useI18n();
  const me = useOnlineMe();
  const [lobbyPeersCount, setLobbyPeersCount] = useState(0);
  const [lobbyPeersDevices, setLobbyPeersDevices] = useState<LobbyPeerDevice[]>([]);
  const [lobbyRole, setLobbyRole] = useState<"sender" | "receiver" | null>(() => getLobbyRole());
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeToLobbyPeersCount(setLobbyPeersCount);
    return unsub;
  }, []);
  useEffect(() => {
    const unsub = subscribeToLobbyPeersDevices(setLobbyPeersDevices);
    return unsub;
  }, []);
  useEffect(() => {
    getDeviceId().then(setCurrentDeviceId).catch(() => {});
  }, []);
  useEffect(() => {
    const unsub = subscribeToLobbyRole(() => setLobbyRole(getLobbyRole()));
    return unsub;
  }, []);

  const PRESETS: {
    key: SortKey;
    label: string;
    icon?: keyof typeof Feather.glyphMap;
  }[] = [
    { key: "date", label: t("explore.sort.latest") || "Новое", icon: "clock" },
    {
      key: "popular-today",
      label: t("explore.sort.popularToday") || "Сегодня",
      icon: "sun",
    },
    {
      key: "popular-week",
      label: t("explore.sort.popularWeek") || "Неделя",
      icon: "calendar",
    },
    {
      key: "popular-month",
      label: t("explore.sort.popularMonth") || "Месяц",
      icon: "calendar",
    },
    {
      key: "popular",
      label: t("explore.sort.popular") || "Горячее",
      icon: "trending-up",
    },
  ];

  const params = useGlobalSearchParams<{
    query?: string | string[];
    id?: string | string[];
    title?: string | string[];
    slug?: string | string[];
    imsearch?: string | string[];
  }>();
  const q = typeof params.query === "string" ? params.query : "";
  const rawImsearch = Array.isArray(params.imsearch) ? params.imsearch[0] : params.imsearch;
  const imsearchActive = rawImsearch === "1" || rawImsearch === "true";
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const bookId = typeof rawId === "string" ? rawId : undefined;
  const rawTitle = Array.isArray(params.title) ? params.title[0] : params.title;
  const bookTitle = typeof rawTitle === "string" ? rawTitle : undefined;
  const rawSlug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const userName =
    typeof rawSlug === "string" ? decodeURIComponent(rawSlug) : undefined;

  function getTitle(
    pathname: string | null | undefined,
    q: string,
    bookTitle?: string,
    bookId?: string,
    imsearch?: boolean
  ) {
    const p = pathname ?? "";
    const has = (seg: string) => new RegExp(`(^|/)${seg}(\\/|$)`).test(p);
    if (p === "/" || has("index")) return t("menu.home");
    if (has("explore")) {
      if (imsearch) return t("search.imageSearchResultsTitle");
      return q ? t("search.results") + ": " + q : t("menu.explore");
    }
    if (has("favorites")) return t("menu.favorites");
    if (has("favoritesOnline")) return t("menu.favoritesOnline");
    if (has("downloaded")) return t("menu.downloaded");
    if (has("recommendations")) return t("menu.recommendations");
    if (has("history")) return t("menu.history");
    if (has("characters")) return t("menu.characters");
    if (has("settings")) return t("menu.settings");
    if (has("book")) return `#${bookId} - ${bookTitle}`;
    if (has("search"))
      return q ? t("menu.search") + ": " + q : t("menu.search");
    if (has("tags")) return t("menu.tags");
    if (has("profile")) return `${t("menu.profile")}: ${userName}`;
    return "NHApp";
  }

  const [backOpen, setBackOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const rotationAnim = useRef(new Animated.Value(0)).current;

  const title = useMemo(
    () => getTitle(pathname, q, bookTitle, bookId, imsearchActive),
    [pathname, q, bookTitle, bookId, imsearchActive, t]
  );
  const showBack = pathname && pathname !== "/" && pathname !== "/index";

  const hideRight =
    hasSeg(pathname, "settings") ||
    hasSeg(pathname, "tags") ||
    hasSeg(pathname, "book") ||
    hasSeg(pathname, "profile") ||
    hasSeg(pathname, "characters") ||
    hasSeg(pathname, "favorites") ||
    hasSeg(pathname, "favoritesOnline");

  const hideSearchFilter = hasSeg(pathname, "recommendations");


  const backOne = () => {
    setBackOpen(false);
    router.back();
  };
  const backTwo = () => {
    setBackOpen(false);
    router.back();
    setTimeout(() => router.back(), 0);
  };
  const backHome = () => {
    setBackOpen(false);
    router.replace("/");
  };

  const hasDateFilter = !!uploaded;

  /** "Within last X" — use uploaded:<X so API returns only recent content */
  const DATE_PRESETS: { value: string; label: string }[] = [
    { value: "uploaded:<2h", label: t("explore.date.2h") || "2 часа" },
    { value: "uploaded:<24h", label: t("explore.date.24h") || "24 часа" },
    { value: "uploaded:<3d", label: t("explore.date.3d") || "3 дня" },
    { value: "uploaded:<7d", label: t("explore.date.7d") || "Неделя" },
    { value: "uploaded:<30d", label: t("explore.date.30d") || "Месяц" },
    { value: "uploaded:<90d", label: t("explore.date.90d") || "3 месяца" },
    { value: "uploaded:<180d", label: t("explore.date.180d") || "6 месяцев" },
    { value: "uploaded:<365d", label: t("explore.date.1y") || "Год" },
  ];

  const dayMs = 24 * 60 * 60 * 1000;

  const applyCalendarRange = (fromDate: Date, toDate: Date) => {
    const now = Date.now();
    const fromDaysAgo = Math.floor((now - fromDate.getTime()) / dayMs);
    const toDaysAgo = Math.floor((now - toDate.getTime()) / dayMs);
    const rangeQuery = `uploaded:>${toDaysAgo - 1}d uploaded:<${fromDaysAgo + 1}d`;
    const fromStr = fromDate.getDate().toString().padStart(2, "0") + "." + (fromDate.getMonth() + 1).toString().padStart(2, "0") + "." + fromDate.getFullYear();
    const toStr = toDate.getDate().toString().padStart(2, "0") + "." + (toDate.getMonth() + 1).toString().padStart(2, "0") + "." + toDate.getFullYear();
    setCustomRangeApplied(
      rangeQuery,
      `${fromStr} – ${toStr}`,
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10)
    );
  };

  const dateSubmenuItems: SelectItem[] = [
    {
      type: "submenu" as const,
      label: t("explore.date.customRange") || "Указать даты…",
      icon: (c: string) => <Feather name="calendar" size={15} color={c} />,
      children: [
        {
          type: "custom" as const,
          label: t("explore.dateRangeCustom") || "Диапазон дат",
          backLabel: t("explore.date.backToDateList") || "Назад к выбору дат",
          content: ({ onClose, openSubmenu }) => (
            <CalendarRangePicker
              onApply={applyCalendarRange}
              onClose={onClose}
              onReset={() => {
                clearUploaded();
                onClose();
              }}
              openSubmenu={openSubmenu}
              initialFrom={lastCustomFrom}
              initialTo={lastCustomTo}
            />
          ),
        },
      ],
    },
    ...DATE_PRESETS.map(({ value: v, label }) => ({
      value: v,
      label,
      indicatorShape: "square" as const,
    })),
  ];

  const uploadedLabel =
    DATE_PRESETS.find((p) => p.value === uploaded || p.value.replace("uploaded:", "") === uploaded)?.label ??
    (uploaded && uploaded.startsWith("uploaded:")
      ? (customRangeLabel || (t("explore.dateRangeCustom") || "Диапазон дат"))
      : null);
  const activeLanguage = useMemo(() => {
    const include = LANGUAGE_OPTIONS.find((name) =>
      (filters as any[]).some(
        (f) => f?.type === "language" && f?.name === name && f?.mode === "include"
      )
    );
    return include ?? null;
  }, [filters]);
  const activeLanguageLabel = useMemo(() => {
    if (!activeLanguage) return t("explore.language.all") || "Все языки";
    if (activeLanguage === "english") return t("explore.language.english") || "English";
    if (activeLanguage === "japanese") return t("explore.language.japanese") || "Japanese";
    if (activeLanguage === "chinese") return t("explore.language.chinese") || "Chinese";
    return t("explore.language.all") || "Все языки";
  }, [activeLanguage, t]);
  const availableLanguageOptions = useMemo(
    () =>
      LANGUAGE_OPTIONS.filter((name) => !blacklistNames.has(name.toLowerCase())),
    [blacklistNames]
  );

  const applyLanguageFilter = useCallback(
    (next: LanguageOption | "all") => {
      for (const name of LANGUAGE_FILTER_KEYS) {
        setMode({ type: "language", name }, null);
      }
      if (next !== "all") {
        setMode({ type: "language", name: next }, "include");
      }
    },
    [setMode]
  );
  useEffect(() => {
    if (!activeLanguage) return;
    if (!availableLanguageOptions.includes(activeLanguage)) {
      applyLanguageFilter("all");
    }
  }, [activeLanguage, applyLanguageFilter, availableLanguageOptions]);

  const lobbyConnSnap = useSyncExternalStore(
    subscribeToLobbyCloudStats,
    getLobbyConnectionSnap,
    () => JSON.stringify(["pending", "first", null] as const)
  );
  const lobbyConn = useMemo((): LobbyConnectionUi => {
    try {
      const [status, phase, pingMs] = JSON.parse(lobbyConnSnap) as [
        LobbyConnectionUi["status"],
        LobbyConnectionUi["phase"],
        number | null,
      ];
      return {
        status,
        phase,
        pingMs: typeof pingMs === "number" && Number.isFinite(pingMs) ? pingMs : null,
      };
    } catch {
      return { status: "pending", phase: "first", pingMs: null };
    }
  }, [lobbyConnSnap]);
  const lobbyCloudHeaderNode = useMemo(
    () => (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Feather name="cloud" size={18} color={colors.accent} />
        <Text
          style={{
            fontSize: 12,
            fontWeight: "800",
            color: colors.txt,
            letterSpacing: 1.1,
            textTransform: "uppercase",
          }}
        >
          {t("lobby.cloudTitle")}
        </Text>
      </View>
    ),
    [colors.accent, colors.txt, t]
  );

  const lobbyCloudPingNode = useMemo(() => {
    const online = lobbyConn.status === "online";
    const msRounded =
      online && lobbyConn.pingMs != null ? Math.max(0, Math.round(lobbyConn.pingMs)) : null;
    let dotColor = colors.sub;
    let line1: string;
    if (online && msRounded != null) {
      dotColor =
        msRounded < 120 ? "#22c55e" : msRounded < 350 ? "#eab308" : "#ef4444";
      line1 = `${msRounded} ms`;
    } else if (online) {
      line1 = "—";
    } else if (lobbyConn.status === "pending") {
      dotColor = "#eab308";
      line1 = "—";
    } else {
      dotColor = "#fb923c";
      line1 = "—";
    }
    const hint =
      lobbyConn.status === "pending"
        ? lobbyConn.phase === "retry"
          ? t("lobby.cloudStatusReconnecting")
          : t("lobby.cloudStatusConnecting")
        : lobbyConn.status === "offline_local"
          ? t("lobby.cloudStatusLocalOnly")
          : null;
    return (
      <View
        style={{
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: colors.page + "44",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.sub + "44",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor }} />
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.txt }}>{line1}</Text>
        </View>
        {hint ? (
          <Text
            style={{
              marginTop: 6,
              fontSize: 12,
              fontWeight: "600",
              color: colors.sub,
              lineHeight: 16,
            }}
            numberOfLines={3}
          >
            {hint}
          </Text>
        ) : null}
      </View>
    );
  }, [lobbyConn, colors.sub, colors.txt, colors.page, t]);

  const lobbyDevicesDropdownItems: SelectItem[] = useMemo(
    () => [
      {
        type: "group" as const,
        label: t("lobby.cloudTitle"),
        labelNode: lobbyCloudHeaderNode,
        subtitle: lobbyCloudPingNode,
      },
      ...(lobbyPeersDevices.length === 0
        ? [{ value: "_empty", label: t("lobby.noPeers") || "Нет подключённых устройств" }]
        : lobbyPeersDevices.map((d) => {
            const isThis = d.device_id === currentDeviceId;
            const role =
              isThis && lobbyRole === "sender"
                ? (c: string) => <Feather name="arrow-up-circle" size={20} color={c} />
                : isThis && lobbyRole === "receiver"
                  ? (c: string) => <Feather name="arrow-down-circle" size={20} color={c} />
                  : undefined;
            return {
              value: d.device_id,
              label: d.device_name || d.device_id || "—",
              icon: (c: string) => <Feather name="smartphone" size={18} color={c} />,
              ...(role ? { trailingIcon: role } : {}),
            };
          })),
    ],
    [lobbyPeersDevices, currentDeviceId, lobbyRole, t, lobbyCloudHeaderNode, lobbyCloudPingNode]
  );

  const sortSelectItems: SelectItem[] = [
    {
      type: "submenu" as const,
      label: `${t("explore.filter.language") || "Выбор языка"}: ${activeLanguageLabel}`,
      icon: (c: string) => <Feather name="globe" size={15} color={c} />,
      children: [
        { value: "lang:all", label: t("explore.language.all") || "Все языки" },
        ...(availableLanguageOptions.includes("english")
          ? [{ value: "lang:english", label: t("explore.language.english") || "English" }]
          : []),
        ...(availableLanguageOptions.includes("japanese")
          ? [{ value: "lang:japanese", label: t("explore.language.japanese") || "Japanese" }]
          : []),
        ...(availableLanguageOptions.includes("chinese")
          ? [{ value: "lang:chinese", label: t("explore.language.chinese") || "Chinese" }]
          : []),
      ],
    },
    {
      type: "submenu" as const,
      label: pagesQuery ? `${t("explore.filter.pages") || "Страницы"}: ${pagesQuery}` : (t("explore.filter.pages") || "Страницы"),
      icon: (c: string) => <Feather name="file-text" size={15} color={c} />,
      children: [
        {
          type: "custom" as const,
          label: t("explore.filter.pages") || "Страницы",
          backLabel: t("explore.date.back") || "Назад",
          preferredHeight: 178,
          content: ({ onClose }) => (
            <PagesFilterEditor
              colors={colors}
              t={t}
              initialQuery={pagesQuery}
              onApply={(query) => {
                setPagesQuery(query);
                onClose();
              }}
              onClear={() => {
                clearPagesQuery();
                onClose();
              }}
            />
          ),
        },
      ],
    },
    {
      type: "submenu" as const,
      label: hasDateFilter && uploadedLabel ? uploadedLabel : (t("explore.dateRange") || "Фильтр по дате"),
      backLabel: t("explore.date.back") || "Назад",
      icon: (c: string) => <Feather name="calendar" size={15} color={c} />,
      children: dateSubmenuItems,
    },
    {
      type: "group" as const,
      label: t("explore.filter.sortTitle") || "Сортировать",
    },
    ...PRESETS.map(({ key, label, icon }) => ({
      value: `sort:${key}`,
      label,
      icon: icon
        ? (c: string) => <Feather name={icon as any} size={15} color={c} />
        : undefined,
    })),
  ];


  useEffect(() => {
    if (Platform.OS !== "web") return;

    const handleRefreshStart = () => {
      setIsRefreshing(true);
      rotationAnim.setValue(0);
      const loopAnim = Animated.loop(
        Animated.timing(rotationAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: false, 
        })
      );
      loopAnim.start();
      (rotationAnim as any)._loopAnim = loopAnim;
    };

    const handleRefreshEnd = () => {
      setIsRefreshing(false);
      const loopAnim = (rotationAnim as any)._loopAnim;
      if (loopAnim) {
        loopAnim.stop();
        delete (rotationAnim as any)._loopAnim;
      }
      rotationAnim.stopAnimation();
      Animated.timing(rotationAnim, {
        toValue: 0,
        duration: 200,
        easing: Easing.ease,
        useNativeDriver: false,
      }).start();
    };

    globalThis.addEventListener?.("app:refresh-content-start", handleRefreshStart);
    globalThis.addEventListener?.("app:refresh-content-end", handleRefreshEnd);

    return () => {
      globalThis.removeEventListener?.("app:refresh-content-start", handleRefreshStart);
      globalThis.removeEventListener?.("app:refresh-content-end", handleRefreshEnd);
      const loopAnim = (rotationAnim as any)._loopAnim;
      if (loopAnim) {
        loopAnim.stop();
      }
      rotationAnim.stopAnimation();
    };
  }, [rotationAnim]);

  const refreshIconStyle = useMemo(() => {
    const rotate = rotationAnim.interpolate({
      inputRange: [0, 1],
      outputRange: ["0deg", "360deg"],
    });
    return {
      transform: [{ rotate }],
    };
  }, [rotationAnim]);

  return (
    <View>
      <Animated.View
        style={[
          styles.bar,
          {
            backgroundColor: colors.searchBg,
            height: BAR_HEIGHT,
            borderBottomColor: colors.page,
          },
        ]}
      >
        {showBack ? (
          <IconBtn
            onPress={() => router.back()}
            onLongPress={() => setBackOpen(true)}
          >
            <Feather name="arrow-left" size={20} color={colors.searchTxt} />
          </IconBtn>
        ) : (
          <IconBtn onPress={openDrawer}>
            <Feather name="menu" size={22} color={colors.searchTxt} />
          </IconBtn>
        )}

        <Text
          numberOfLines={1}
          style={[styles.title, { color: colors.searchTxt }]}
        >
          {title}
        </Text>

        {(!hideRight || action) && (
          <View style={styles.rightGroup}>
            {action ? (
              <Pressable
                onPress={action.onPress}
                disabled={action.disabled}
                style={({ pressed }) => [
                  styles.actionBtn,
                  {
                    borderColor:
                      (action.kind ?? "default") === "primary"
                        ? colors.accent + "55"
                        : colors.page + "55",
                    backgroundColor: colors.searchBg,
                    opacity: action.disabled ? 0.55 : pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.actionBtnText, { color: colors.searchTxt }]}>
                  {action.label}
                </Text>
              </Pressable>
            ) : null}
            {!hideRight ? (
              <>
                {me && (
                  <FilterDropdown
                    value={undefined}
                    options={lobbyDevicesDropdownItems}
                    keepOpen
                    hideRadio
                    trigger={({ onPress }) => (
                      <Pressable
                        onPress={onPress}
                        style={({ pressed }) => [styles.lobbyBadgeWrap, pressed && { opacity: 0.8 }]}
                      >
                        <Feather name="cloud" size={18} color={colors.searchTxt} />
                        {lobbyPeersCount > 0 && (
                          <View style={[styles.lobbyBadge, { backgroundColor: colors.accent }]}>
                            <Text style={styles.lobbyBadgeText} numberOfLines={1}>
                              {lobbyPeersCount > 99 ? "99+" : lobbyPeersCount}
                            </Text>
                          </View>
                        )}
                      </Pressable>
                    )}
                  />
                )}
                {Platform.OS === "web" && (
                  <IconBtn
                    onPress={() => {
                      if (isRefreshing) return; 
                      if (typeof globalThis !== "undefined") {
                        globalThis.dispatchEvent?.(
                          new globalThis.CustomEvent("app:refresh-content")
                        );
                      }
                    }}
                    disabled={isRefreshing}
                  >
                    <Animated.View style={refreshIconStyle}>
                      <Feather 
                        name="refresh-cw" 
                        size={18} 
                        color={isRefreshing ? colors.accent : colors.searchTxt}
                      />
                    </Animated.View>
                  </IconBtn>
                )}

                {!hideSearchFilter && (
                  <IconBtn
                    onPress={() => {
                      router.push({
                        pathname: "/search",
                        params: q ? { query: q } : {},
                      });
                    }}
                  >
                    <Feather name="search" size={18} color={colors.searchTxt} />
                  </IconBtn>
                )}

                {!hideSearchFilter && (
                  <FilterDropdown
                    value={activeLanguage ? `lang:${activeLanguage}` : "lang:all"}
                    secondaryValue={uploaded ? uploaded : `sort:${sort}`}
                    onChange={(val) => {
                      if (val.startsWith("lang:")) {
                        const next = val.slice(5) as LanguageOption | "all";
                        applyLanguageFilter(next);
                        return;
                      }
                      if (val.startsWith("sort:")) {
                        setSort(val.slice(5) as SortKey);
                        return;
                      }
                      const isDatePreset = DATE_PRESETS.some((p) => p.value === val);
                      if (isDatePreset) {
                        setUploaded(val === uploaded ? null : val);
                      } else {
                        setSort(val as SortKey);
                      }
                    }}
                    options={sortSelectItems}
                    maxDropdownHeight={560}
                    keepOpen
                    trigger={({ onPress }) => (
                      <IconBtn onPress={onPress}>
                        <Feather name="filter" size={18} color={colors.accent} />
                      </IconBtn>
                    )}
                  />
                )}

                <IconBtn onPress={() => router.push("/tags")}>
                  <Feather name="tag" size={18} color={colors.accent} />
                </IconBtn>
              </>
            ) : null}
          </View>
        )}
      </Animated.View>

      <NhModal
        visible={backOpen}
        onClose={() => setBackOpen(false)}
        sheetStyle={{
          backgroundColor: colors.searchBg,
          borderColor: colors.page,
        }}
        title={t("common.back")}
      >
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={{ paddingVertical: 4, paddingHorizontal: 8 }}
          showsVerticalScrollIndicator={false}
        >
          <Pressable style={[styles.sortRow, styles.rounded]} onPress={backOne}>
            <Text style={[styles.sortTxt, { color: colors.searchTxt }]}>
              {t("searchBar.backOne")}
            </Text>
          </Pressable>
          <Pressable style={[styles.sortRow, styles.rounded]} onPress={backTwo}>
            <Text style={[styles.sortTxt, { color: colors.searchTxt }]}>
              {t("searchBar.backTwo")}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.sortRow, styles.rounded]}
            onPress={backHome}
          >
            <Text style={[styles.sortTxt, { color: colors.searchTxt }]}>
              {t("searchBar.backHome")}
            </Text>
          </Pressable>
        </ScrollView>
      </NhModal>

    </View>
  );
}

const styles = StyleSheet.create({
  rounded: { borderRadius: 12, overflow: "hidden" },

  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    elevation: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    zIndex: 20,
  },
  title: {
    marginLeft: 8,
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    textAlignVertical: "center",
  },
  rightGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: 6,
  },
  actionBtn: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    marginRight: 6,
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: "800",
  },
  iconBtnRound: {
    width: BTN_SIDE,
    height: BTN_SIDE,
    borderRadius: 12,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  lobbyBadgeWrap: {
    width: BTN_SIDE,
    height: BTN_SIDE,
    alignItems: "center",
    justifyContent: "center",
  },
  lobbyBadge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  lobbyBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },

  sheetScroll: {},
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginVertical: 2,
  },
  sortTxt: { fontSize: 15 },
  pagesWrap: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  pagesModeRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  pagesModeBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  pagesInputRow: {
    flexDirection: "row",
    gap: 8,
  },
  pagesInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  pagesActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pagesApplyBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },

});

export default SearchBar;
