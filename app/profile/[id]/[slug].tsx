// app/profile/[id]/[slug].tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import type { Book } from "@/api/nhentai";
import { getBook } from "@/api/nhentai";
import {
  getMe,
  getUserOverview,
  type Me,
  type UserOverview,
} from "@/api/nhentaiOnline";
import BookList from "@/components/BookList";
import CommentCard from "@/components/CommentCard";
import { useWindowLayout } from "@/hooks/book/useWindowLayout";
import { useGridConfig } from "@/hooks/useGridConfig";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";

import { differenceInDays, differenceInMonths } from "date-fns";

const AVATAR_SIZE = 112;
const BANNER_HEIGHT = 140;
const DESKTOP_BREAKPOINT = 900;

let ImageColors: any = null;
try {
  ImageColors = require("react-native-image-colors");
} catch {}

function toLightBook(b: Book): Book {
  return {
    ...b,
    artists: Array.isArray(b.artists) ? b.artists : [],
    categories: Array.isArray(b.categories) ? b.categories : [],
    characters: Array.isArray(b.characters) ? b.characters : [],
    groups: Array.isArray(b.groups) ? b.groups : [],
    languages: Array.isArray(b.languages) ? b.languages : [],
    parodies: Array.isArray(b.parodies) ? b.parodies : [],
    tags: Array.isArray(b.tags) ? b.tags : [],
    pagesCount: Number.isFinite(b.pagesCount) ? b.pagesCount : 0,
    favorites: Number.isFinite(b.favorites) ? b.favorites : 0,
  };
}

function decodeHtml(s: string): string {
  if (!s) return "";
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function darken(hex: string, amount = 0.12): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#2a2a2a";
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 0xff,
    g = (n >> 8) & 0xff,
    b = n & 0xff;
  r = Math.max(0, Math.floor(r * (1 - amount)));
  g = Math.max(0, Math.floor(g * (1 - amount)));
  b = Math.max(0, Math.floor(b * (1 - amount)));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function rgbToHex(rgb: string): string {
  const m = /rgb\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)\s*\)/i.exec(rgb);
  if (!m) return rgb;
  const r = (+m[1]).toString(16).padStart(2, "0");
  const g = (+m[2]).toString(16).padStart(2, "0");
  const b = (+m[3]).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff,
    g = (n >> 8) & 0xff,
    b = n & 0xff;
  const L =
    0.2126 * (r / 255) ** 2.2 +
    0.7152 * (g / 255) ** 2.2 +
    0.0722 * (b / 255) ** 2.2;
  return L > 0.6;
}

const Skeleton = ({ style }: { style?: any }) => {
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.6,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        { backgroundColor: "#FFFFFF14", borderRadius: 10 },
        style,
        { opacity },
      ]}
    />
  );
};

const trimTrailingSlash = (u?: string | null) =>
  (u ?? "").trim().replace(/\/+$/, "");

/* -------------------- локализация длительности без ICU -------------------- */
function pluralRu(n: number, one: string, few: string, many: string) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function formatJoinedAgo(
  lang: "en" | "ru" | "ja" | "zh",
  years: number,
  months: number,
  daysSince: number
): string {
  // если меньше месяца — отдельные «just now» варианты
  if (years === 0 && months === 0) {
    switch (lang) {
      case "ru":
        return "Зарегистрирован недавно";
      case "ja":
        return "登録したばかり";
      case "zh":
        return "刚注册";
      default:
        return "Just joined";
    }
  }

  switch (lang) {
    case "ru": {
      const y = years
        ? `${years} ${pluralRu(years, "год", "года", "лет")}`
        : "";
      const m = months
        ? `${months} ${pluralRu(months, "месяц", "месяца", "месяцев")}`
        : "";
      const body = [y, m].filter(Boolean).join(" ");
      return `Зарегистрирован: ${body} назад`;
    }
    case "ja": {
      const y = years ? `${years}年` : "";
      const m = months ? `${months}か月` : "";
      return `登録してから${y}${m}`;
    }
    case "zh": {
      const y = years ? `${years}年` : "";
      const m = months ? `${months}个月` : "";
      return `注册已有${y}${m}`;
    }
    default: {
      const y = years ? `${years} year${years !== 1 ? "s" : ""}` : "";
      const m = months ? `${months} month${months !== 1 ? "s" : ""}` : "";
      const body = [y, m].filter(Boolean).join(" ");
      return `Joined: ${body} ago`;
    }
  }
}
/* ------------------------------------------------------------------------- */

export default function UserProfileScreen() {
  const { colors } = useTheme();
  const { t, resolved } = useI18n();
  const lang = (resolved ?? "en") as "en" | "ru" | "ja" | "zh";

  const router = useRouter();
  const { id, slug } = useLocalSearchParams<{ id: string; slug?: string }>();
  const { innerPadding } = useWindowLayout();
  const { width: winW, height: winH } = useWindowDimensions();

  const isDesktop = winW >= DESKTOP_BREAKPOINT;
  const isMobile = !isDesktop;

  const [busy, setBusy] = useState(true);
  const [ov, setOv] = useState<UserOverview | null>(null);
  const [viewer, setViewer] = useState<Me | null>(null);
  const [recent, setRecent] = useState<Book[]>([]);
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [bannerColor, setBannerColor] = useState<string>("#2a2a2a");
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  const joinedAgoLabel = useMemo(() => {
    if (!ov?.joinedAt) return "";
    const now = new Date();
    const joined = new Date(ov.joinedAt);
    const totalMonths = differenceInMonths(now, joined);
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const days = differenceInDays(now, joined);
    return formatJoinedAgo(lang, years, months, days);
  }, [ov?.joinedAt, lang]);

  const PAD = winW < 380 ? 12 : 16;

  const ui = useMemo(() => {
    const text = (colors as any).txt ?? colors.title ?? "#e6e7e9";
    const sub = (colors as any).metaText ?? colors.sub ?? "#a6abb3";
    const baseCard = (colors as any).surfaceElevated ?? "#13161a";
    const card = darken(baseCard, 0.06);
    const itemBg = darken(card, 0.06);
    return {
      bg: colors.bg,
      card,
      itemBg,
      text,
      sub,
      title: colors.title ?? text,
      accent: colors.accent,
      onAccent: "#fff",
      chipBg: (colors as any).tagBg ?? "#ffffff12",
      chipText: (colors as any).tagText ?? text,
      lineSoft: "#ffffff14",
      bannerFallback: (colors as any).banner ?? colors.accent ?? "#2a2a2a",
      ripple: (colors as any).accent ? colors.accent + "18" : "#ffffff18",
    };
  }, [colors]);

  const selectGoodHex = (res: any): string | null => {
    const cands: (string | undefined)[] = [
      res?.dominant,
      res?.vibrant,
      res?.average,
      res?.darkVibrant,
      res?.lightVibrant,
      res?.primary,
      res?.background,
    ];
    const first = cands.find(Boolean);
    if (!first) return null;
    let hx = first;
    if (/^rgb/i.test(hx)) hx = rgbToHex(hx);
    if (!/^#?[0-9a-f]{6}$/i.test(hx)) return null;
    return hx[0] === "#" ? hx : `#${hx}`;
  };

  const pickBannerFrom = useCallback(
    async (url?: string) => {
      try {
        if (!url || !ImageColors) return setBannerColor(ui.bannerFallback);
        const res = await ImageColors.getColors(url, {
          fallback: ui.bannerFallback,
          cache: true,
          key: url,
          quality: "low",
        });
        let hex = selectGoodHex(res) ?? ui.bannerFallback;
        if (!/^#?[0-9a-f]{6}$/i.test(hex)) hex = ui.bannerFallback;
        if (hex[0] !== "#") hex = `#${hex}`;
        const final = isLight(hex) ? darken(hex, 0.35) : darken(hex, 0.12);
        setBannerColor(final);
      } catch {
        setBannerColor(ui.bannerFallback);
      }
    },
    [ui.bannerFallback]
  );

  useEffect(() => {
    (async () => {
      try {
        const me = await getMe();
        setViewer(me ?? null);
      } catch {
        setViewer(null);
      }
    })();
  }, []);

  useEffect(() => {
    pickBannerFrom(ov?.me?.avatar_url);
  }, [ov?.me?.avatar_url, pickBannerFrom]);

  useEffect(() => {
    AsyncStorage.getItem("bookFavorites").then((j) => {
      const list = j ? (JSON.parse(j) as number[]) : [];
      setFavorites(new Set(list));
    });
  }, []);

  const toggleFav = useCallback((bid: number, next: boolean) => {
    setFavorites((prev) => {
      const copy = new Set(prev);
      next ? copy.add(bid) : copy.delete(bid);
      AsyncStorage.setItem("bookFavorites", JSON.stringify([...copy])).catch(
        () => {}
      );
      return copy;
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setBusy(true);
      const overview = await getUserOverview(Number(id), slug).catch(
        () => null
      );
      if (!mounted) return;
      setOv(overview);

      const ids = (overview?.recentFavoriteIds || []).slice(0, 12);
      const books = (
        await Promise.all(ids.map((g) => getBook(g).catch(() => null)))
      ).filter(Boolean) as Book[];
      setRecent(books.map(toLightBook));

      setBusy(false);
    })();
    return () => void (mounted = false);
  }, [id, slug]);

  const baseGrid = useGridConfig();
  const favGrid = useMemo(
    () => ({
      ...baseGrid,
      numColumns: winW < 420 ? 2 : winW < 900 ? 6 : 6,
      minColumnWidth: 160,
      columnGap: 14,
      paddingHorizontal: PAD,
    }),
    [baseGrid, winW, PAD]
  );

  const favoriteTagsTextRaw = ov?.favoriteTagsText
    ? decodeHtml(ov.favoriteTagsText)
    : "";
  const favoriteTags: string[] =
    (ov?.favoriteTags && ov.favoriteTags.length
      ? ov.favoriteTags
      : favoriteTagsTextRaw
          .split(",")
          .map((s) => decodeHtml(s).trim())
          .filter(Boolean)) || [];

  const aboutText = ov?.about ? decodeHtml(ov.about).trim() : "";
  const showTags = favoriteTags.length > 0;
  const showAbout = aboutText.length > 0;
  const profileUrl = trimTrailingSlash(ov?.me?.profile_url);
  const canEdit = Boolean(
    viewer?.id && ov?.me?.id && Number(viewer.id) === Number(ov.me.id)
  );

  const Title = ({ children }: { children: React.ReactNode }) => (
    <Text style={[styles.sectionTitle, { color: ui.title }]}>{children}</Text>
  );

  const ProfilePanel = (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: ui.card,
          paddingBottom: isMobile ? 0 : PAD,
          borderRadius: isMobile ? 0 : 18,
        },
      ]}
    >
      {busy && !ov ? (
        <Skeleton
          style={{ height: BANNER_HEIGHT, borderRadius: isMobile ? 0 : 18 }}
        />
      ) : (
        <View
          style={[
            styles.banner,
            {
              height: BANNER_HEIGHT,
              backgroundColor: bannerColor,
              borderTopLeftRadius: isMobile ? 0 : 18,
              borderTopRightRadius: isMobile ? 0 : 18,
            },
          ]}
        />
      )}

      <View style={{ marginTop: -AVATAR_SIZE / 2, paddingHorizontal: PAD }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <View>
            {(!avatarLoaded || (busy && !ov)) && (
              <Skeleton
                style={{
                  width: AVATAR_SIZE,
                  height: AVATAR_SIZE,
                  borderRadius: 32,
                }}
              />
            )}
            <Image
              source={{ uri: ov?.me?.avatar_url }}
              onLoadEnd={() => {
                setAvatarLoaded(true);
                pickBannerFrom(ov?.me?.avatar_url);
              }}
              style={{
                width: AVATAR_SIZE,
                height: AVATAR_SIZE,
                borderRadius: 32,
                borderWidth: 6,
                borderColor: ui.card,
                position: avatarLoaded ? "relative" : "absolute",
                opacity: avatarLoaded ? 1 : 0,
              }}
            />
          </View>
        </View>
      </View>

      <View style={{ paddingHorizontal: PAD, marginTop: 12 }}>
        {busy && !ov ? (
          <>
            <Skeleton style={{ height: 24, width: "60%" }} />
            <View style={{ height: 8 }} />
            <Skeleton style={{ height: 14, width: 120 }} />
          </>
        ) : (
          <>
            <Text
              style={[styles.displayName, { color: ui.title }]}
              numberOfLines={1}
            >
              {ov?.me?.username || "user"}
            </Text>
            {Number.isFinite(ov?.me?.id as number) && (
              <Text
                style={[styles.subline, { color: ui.sub }]}
                numberOfLines={1}
              >
                ID: {ov?.me?.id}
              </Text>
            )}
          </>
        )}
      </View>

      {canEdit && (
        <View
          style={{
            paddingHorizontal: PAD,
            marginTop: 12,
            flexDirection: "row",
            gap: 8,
          }}
        >
          <Pressable
            onPress={() => router.push("/settings")}
            android_ripple={{ color: ui.ripple, borderless: true }}
            style={[styles.primaryBtn, { backgroundColor: ui.accent }]}
          >
            <Text style={[styles.primaryBtnTxt, { color: ui.onAccent }]}>
              {t("storageManager.actions.edit")}
            </Text>
          </Pressable>
        </View>
      )}

      <View style={{ paddingHorizontal: PAD, marginTop: 16 }}>
        {showAbout && (
          <Text style={{ color: ui.text, lineHeight: 20, marginBottom: 10 }}>
            {aboutText}
          </Text>
        )}
        {!!profileUrl && (
          <Pressable onPress={() => Linking.openURL(profileUrl)}>
            <Text style={{ color: ui.accent, marginTop: 6 }} numberOfLines={1}>
              🔗 {profileUrl}
            </Text>
          </Pressable>
        )}
        {!busy && !!joinedAgoLabel && (
          <Text style={{ color: ui.sub, marginTop: 6 }}>
            📅 {joinedAgoLabel}
          </Text>
        )}
      </View>

      {showTags && !busy && (
        <View
          style={{ paddingHorizontal: PAD, marginTop: 18, paddingBottom: 6 }}
        >
          <Text style={[styles.subheader, { color: ui.title }]}>
            {t("tags.tags")}
          </Text>
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}
          >
            {favoriteTags.slice(0, 36).map((t_) => (
              <View
                key={t_}
                style={[styles.tag, { backgroundColor: ui.chipBg }]}
              >
                <Text
                  style={[styles.tagTxt, { color: ui.chipText }]}
                  numberOfLines={1}
                >
                  {t_}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );

  const RightPanel = (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: ui.card,
          borderRadius: isMobile ? 0 : 18,
          paddingTop: PAD,
          paddingBottom: PAD,
        },
      ]}
    >
      <View style={{ paddingHorizontal: PAD, marginBottom: 8 }}>
        <Title>{t("menu.favorites")}</Title>
      </View>

      {busy && recent.length === 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: PAD }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              style={{
                width: 180,
                height: 260,
                borderRadius: 16,
                marginRight: 14,
              }}
            />
          ))}
        </ScrollView>
      ) : recent.length === 0 ? (
        <Text
          style={{ color: ui.sub, paddingHorizontal: PAD, paddingVertical: 12 }}
        >
          {t("historyNotFound")}
        </Text>
      ) : (
        <BookList
          data={recent}
          loading={busy && recent.length === 0}
          refreshing={false}
          onRefresh={async () => {}}
          isFavorite={(bid) => favorites.has(bid)}
          onToggleFavorite={toggleFav}
          onPress={(bid) => {
            const b = recent.find((x) => x.id === bid);
            router.push({
              pathname: "/book/[id]",
              params: { id: String(bid), title: b?.title.pretty },
            });
          }}
          gridConfig={{ default: favGrid }}
          horizontal
          background={ui.card}
        />
      )}

      <View style={{ paddingHorizontal: PAD, marginTop: 14, marginBottom: 8 }}>
        <Title>{t("comments.title")}</Title>
      </View>

      <View style={{ paddingHorizontal: PAD, gap: 10 }}>
        {busy && !ov ? (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  gap: 10,
                  alignItems: "flex-start",
                }}
              >
                <Skeleton style={{ width: 38, height: 38, borderRadius: 10 }} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton style={{ height: 14, width: "65%" }} />
                  <Skeleton style={{ height: 14, width: "90%" }} />
                </View>
              </View>
            ))}
          </>
        ) : (
          <>
            {(ov?.recentComments || []).slice(0, 20).map((c) => (
              <CommentCard
                key={c.id}
                id={c.id}
                body={c.body}
                post_date={c.post_date}
                poster={
                  ov?.me
                    ? {
                        id: ov.me.id,
                        username: ov.me.username,
                        slug: ov.me.slug,
                        avatar_url: ov.me.avatar_url,
                      }
                    : undefined
                }
                avatar={c.avatar_url || ov?.me?.avatar_url}
                highlight={false}
                onPress={() =>
                  router.push({
                    pathname: "/book/[id]",
                    params: { id: String(c.gallery_id) },
                  })
                }
              />
            ))}
            {(ov?.recentComments?.length || 0) === 0 && !busy && (
              <Text style={{ color: ui.sub, paddingVertical: 4 }}>
                {t("historyNotFound")}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui.bg }}>
      <Stack.Screen options={{ headerShown: false }} />

      {isDesktop ? (
        <View
          style={[
            styles.desktopRow,
            {
              paddingHorizontal: innerPadding,
              paddingTop: 22,
              paddingBottom: 22,
              gap: 18,
            },
          ]}
        >
          <View
            style={{
              width: 380,
              flexShrink: 0,
              borderRadius: 18,
              overflow: "hidden",
            }}
          >
            <ScrollView
              style={{ maxHeight: winH }}
              showsVerticalScrollIndicator={false}
            >
              {ProfilePanel}
            </ScrollView>
          </View>

          <View style={{ flex: 1, borderRadius: 18, overflow: "hidden" }}>
            <ScrollView showsVerticalScrollIndicator>{RightPanel}</ScrollView>
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 0 }}
          showsVerticalScrollIndicator={false}
        >
          {ProfilePanel}
          {RightPanel}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  desktopRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  panel: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
    overflow: "hidden",
  },
  banner: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  displayName: { fontWeight: "900", fontSize: 24, letterSpacing: 0.2 },
  subline: { marginTop: 4, fontSize: 13, letterSpacing: 0.2 },
  sectionTitle: { fontWeight: "700", fontSize: 16, letterSpacing: 0.6 },
  subheader: { fontWeight: "700", fontSize: 16, letterSpacing: 0.6 },
  primaryBtn: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryBtnTxt: { fontWeight: "800", letterSpacing: 0.3 },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    marginRight: 8,
    marginTop: 8,
  },
  tagTxt: { fontWeight: "700", fontSize: 12 },
});
