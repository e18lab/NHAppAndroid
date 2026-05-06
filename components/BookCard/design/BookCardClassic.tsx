import { Feather } from "@expo/vector-icons";
import { format } from "date-fns";
import { BlurTargetView, BlurView } from "expo-blur";
import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import type { Book } from "@/api/nhappApi/types";
import { buildImageFallbacks } from "@/components/buildImageFallbacks";
import SmartImageWithRetry from "@/components/SmartImageWithRetry";
import { useFilterTags } from "@/context/TagFilterContext";
import {
  isBookBlacklisted,
  useBlacklistNameSet,
  useBlacklistSet,
} from "@/lib/blacklistFilter";
import { useI18n } from "@/lib/i18n/I18nContext";
import { useTheme } from "@/lib/ThemeContext";
import { makeCardStyles } from "../BookCard.styles";

const LANG_TAG_JP = 6346;
const LANG_TAG_CN = 29963;
const LANG_TAG_EN = 12227;

function languageKeyFromTagIdList(ids: number[] | undefined): string | undefined {
  if (!ids?.length) return undefined;
  for (const id of ids) {
    if (id === LANG_TAG_JP) return "japanese";
    if (id === LANG_TAG_CN) return "chinese";
    if (id === LANG_TAG_EN) return "english";
  }
  return undefined;
}

function inferLanguageKeyFromBook(book: Book): string | undefined {
  const fromList = languageKeyFromTagIdList(book.tagIds);
  if (fromList) return fromList;
  return languageKeyFromTagIdList(book.tags?.map((t) => t.id));
}

export interface BookCardClassicProps {
  book: Book;
  cardWidth?: number;
  contentScale?: number;
  isFavorite?: boolean;
  onPress?: (id: number) => void;
  background?: string;
  score?: number;
}

export default function BookCardClassic({
  book,
  cardWidth = 160,
  contentScale = 1,
  onPress,
  background,
  score,
}: BookCardClassicProps) {
  const { colors } = useTheme();
  const { t, resolvedDateFns } = useI18n();
  const { cycle, modeOf } = useFilterTags();
  const styles = useMemo(
    () => makeCardStyles(colors, cardWidth, contentScale),
    [colors, cardWidth, contentScale]
  );
  const blacklistIds = useBlacklistSet();
  const blacklistNames = useBlacklistNameSet();
  const isBlacklisted = useMemo(
    () => isBookBlacklisted(book, blacklistIds, blacklistNames),
    [blacklistIds, blacklistNames, book]
  );

  const [hovered, setHovered] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const blurTargetRef = useRef<View | null>(null);

  const fullTitle = book.title?.pretty ?? "";

  const langName = (() => {
    const arr = book.languages || [];
    if (arr?.length) {
      const p = arr[0]?.name?.toLowerCase();
      const s = arr[1]?.name?.toLowerCase();
      return p === "translated" && s ? s : p;
    }
    return inferLanguageKeyFromBook(book);
  })();

  const sources = buildImageFallbacks(book.cover);

  const handlePressCard = () => onPress?.(book.id);

  const year = (() => {
    const d = book.uploaded ? new Date(book.uploaded) : null;
    const y = d && Number.isFinite(d.getTime()) ? d.getFullYear() : undefined;
    return y && y > 1970 ? y : undefined;
  })();
  const displayYear = year ?? new Date().getFullYear();
  const uploadedDate = useMemo(() => {
    if (!book.uploaded) return null;
    const d = new Date(book.uploaded);
    return Number.isFinite(d.getTime()) ? d : null;
  }, [book.uploaded]);
  const displayDate = useMemo(() => {
    if (!uploadedDate) return String(displayYear);
    try {
      // e.g. "31 Mar 2026" / localized month for ru/ja/zh
      return format(uploadedDate, "d MMM yyyy", { locale: resolvedDateFns as any });
    } catch {
      return String(displayYear);
    }
  }, [uploadedDate, displayYear, resolvedDateFns]);
  const isNew = useMemo(() => {
    if (!uploadedDate) return false;
    const diff = Date.now() - uploadedDate.getTime();
    return diff >= 0 && diff <= 2 * 60 * 60 * 1000;
  }, [uploadedDate]);
  const pages = book.pagesCount || book.pages?.length || undefined;
  const scoreClamped =
    typeof score === "number" && Number.isFinite(score)
      ? Math.max(0, Math.min(5, score))
      : undefined;

  const langShort = (() => {
    const s = (langName ? langName.slice(0, 2) : "").toUpperCase();
    // user requested JP instead of JA
    return s === "JA" ? "JP" : s;
  })();

  type ChipType = "artist" | "parody" | "character" | "category" | "tag";
  type Chip = { type: ChipType; name: string };

  const chips = useMemo(() => {
    const pick = (arr: any[] | undefined, type: ChipType): Chip[] =>
      (arr ?? [])
        .map((x) => String(x?.name ?? "").trim())
        .filter(Boolean)
        .map((name) => ({ type, name }));

    // tags: only plain tag type; exclude language/group/etc
    const onlyPlainTags: any[] = (book.tags ?? []).filter((x: any) => (x?.type ?? "tag") === "tag");

    const ordered: Chip[] = [
      ...pick(book.artists as any, "artist"),
      ...pick(book.parodies as any, "parody"),
      ...pick(book.characters as any, "character"),
      ...pick(book.categories as any, "category"),
      ...pick(onlyPlainTags as any, "tag"),
    ];

    const seen = new Set<string>();
    const out: Chip[] = [];
    for (const c of ordered) {
      const k = `${c.type}::${c.name}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }, [book.artists, book.parodies, book.characters, book.categories, book.tags]);

  // ── Collapsed chips: instant predictive packing (no measurement, no flicker) ──
  const collapsedMaxRows = 2;
  const chipGap = 5;
  const chipPadX = 7 * 2;
  const chipBorder = 1;
  const approxLatinCharW = 5.3; // fontSize:10 fontWeight:600 — slightly conservative to prevent 3-row overflow
  const approxCjkCharW = 9.2;
  // tagText has maxWidth:120 → chip pixel cap = 120 + padding + border = 135
  const chipMaxW = 120 + chipPadX + chipBorder;

  const isCjk = (s: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(s);
  const estTextW = (s: string) => {
    const per = isCjk(s) ? approxCjkCharW : approxLatinCharW;
    return Math.ceil(s.length * per);
  };
  // Chip width is capped by tagText maxWidth:120
  const estChipW = (name: string) => Math.min(chipMaxW, chipPadX + chipBorder + estTextW(name));
  // "+N" width scales with digit count so "+1" ≠ "+17"
  const estPlusChipW = (n: number) =>
    chipPadX + chipBorder + Math.ceil((String(n).length + 1) * approxLatinCharW);

  // Subtract a small safety margin so estimation errors don't push us into a 3rd row
  const availableW = Math.max(120, cardWidth - 8 - 6);

  /**
   * Pack the first `n` chips into rows.
   * The first chip on any row is always placed (even if wider than availableW).
   * Returns { fits, lastRow, lastRowX }.
   */
  const simulatePack = (n: number): { fits: boolean; lastRow: number; lastRowX: number } => {
    let row = 1;
    let x = 0;
    for (let i = 0; i < n; i++) {
      const w = estChipW(chips[i].name);
      if (x === 0) {
        x = w;
      } else {
        const next = x + chipGap + w;
        if (next > availableW) {
          row += 1;
          if (row > collapsedMaxRows) return { fits: false, lastRow: row, lastRowX: x };
          x = w;
        } else {
          x = next;
        }
      }
    }
    return { fits: true, lastRow: row, lastRowX: x };
  };

  const collapsedCount = useMemo(() => {
    if (tagsExpanded) return chips.length;
    if (chips.length === 0) return 0;

    // Find max chips that fit in collapsedMaxRows rows
    let count = 0;
    for (let i = 1; i <= chips.length; i++) {
      if (simulatePack(i).fits) count = i;
      else break;
    }

    // If chips are hidden, ensure "+N" pill also fits
    if (count < chips.length) {
      while (count > 0) {
        const { lastRow, lastRowX } = simulatePack(count);
        const hidden = chips.length - count;
        const plusW = estPlusChipW(hidden);
        // Option 1: +N fits on the same row as the last chip
        if (lastRowX + chipGap + plusW <= availableW) break;
        // Option 2: +N wraps to the next row and that row is still within collapsedMaxRows
        if (lastRow < collapsedMaxRows) break;
        count--;
      }
      // Always show at least 1 chip — never just a bare "+N"
      if (count === 0) count = 1;
    }

    return count;
  }, [tagsExpanded, chips, availableW]);

  const moreTags = Math.max(0, chips.length - collapsedCount);
  const visibleChips = useMemo(() => {
    if (tagsExpanded) return chips;
    // collapsedCount already accounts for the +N chip's space — use it directly
    return chips.slice(0, collapsedCount);
  }, [chips, tagsExpanded, collapsedCount]);

  const hasMetaRow =
    !!langShort || (typeof pages === "number" && pages > 0) || !!year || scoreClamped != null;

  const collectingInfoText = t("bookcard.collectingInfo");
  const hiddenByBlacklistText =
    t("bookcard.hiddenByBlacklist") || "Скрыто чёрным списком";

  const downloadingLabel = (book as any)?.__downloading ? "Downloading" : null;
  const downloadingProgressRaw = (book as any)?.__downloadProgress;
  const downloadingPct =
    downloadingLabel && typeof downloadingProgressRaw === "number"
      ? Math.round(Math.max(0, Math.min(1, downloadingProgressRaw)) * 100)
      : null;

  return (
    <>
      <Pressable
        style={({ pressed }) => [
          localStyles.card,
          background ? { backgroundColor: background } : undefined,
          hovered && Platform.OS === "web" ? localStyles.cardHoverDim : null,
          pressed ? localStyles.cardPressed : null,
          Platform.OS === "web" ? (localStyles.webTransition as any) : null,
          { width: cardWidth },
        ]}
        onPress={handlePressCard}
        onHoverIn={Platform.OS === "web" ? () => setHovered(true) : undefined}
        onHoverOut={Platform.OS === "web" ? () => setHovered(false) : undefined}
      >
        {/* ── Cover ── */}
        <View style={[styles.imageWrap, localStyles.imageWrap]}>
          <BlurTargetView ref={blurTargetRef} style={StyleSheet.absoluteFillObject}>
            <SmartImageWithRetry
              sources={sources}
              style={styles.cover}
              maxRetries={3}
              retryDelay={1000}
            />
          </BlurTargetView>
          {isBlacklisted && (
            <BlurView
              pointerEvents="none"
              intensity={100}
              tint="dark"
              blurMethod={Platform.OS === "android" ? "dimezisBlurViewSdk31Plus" : undefined}
              blurTarget={blurTargetRef}
              style={StyleSheet.absoluteFillObject}
            />
          )}
          {isBlacklisted && <View pointerEvents="none" style={localStyles.coverBlacklistedDim} />}
          {isBlacklisted && (
            <View pointerEvents="none" style={localStyles.blacklistNotice}>
              <Feather name="eye-off" size={12} color="#FFFFFF" />
              <Text style={localStyles.blacklistNoticeText} numberOfLines={1}>
                {hiddenByBlacklistText}
              </Text>
            </View>
          )}
          {/* flag intentionally removed (requested) */}
          {isNew && (
            <View pointerEvents="none" style={localStyles.newBadge}>
              <Text style={localStyles.newBadgeText}>{t("book.new")}</Text>
            </View>
          )}
          {!!downloadingLabel && (
            <View pointerEvents="none" style={dl.overlay}>
              <Text style={dl.overlayText} numberOfLines={1}>
                {downloadingPct != null ? `${downloadingLabel} · ${downloadingPct}%` : downloadingLabel}
              </Text>
            </View>
          )}
        </View>

        {/* ── Info block (below image, no overlay) ── */}
        <View style={localStyles.infoBlock}>
          {!!fullTitle && (
            <Text style={localStyles.title} numberOfLines={2} ellipsizeMode="tail">
              {fullTitle}
            </Text>
          )}

          {hasMetaRow && (
            <View style={localStyles.metaRow}>
              {!!langShort && <Text style={localStyles.metaText}>{langShort}</Text>}
              {!!langShort && typeof pages === "number" && pages > 0 && (
                <View style={localStyles.dot} />
              )}
              {typeof pages === "number" && pages > 0 && (
                <Text style={localStyles.metaText}>{pages} стр.</Text>
              )}
              {(!!langShort || (typeof pages === "number" && pages > 0)) && <View style={localStyles.dot} />}
              <Text style={localStyles.metaText}>{displayDate}</Text>
              {scoreClamped != null && (
                <>
                  <View style={localStyles.dot} />
                  <Text style={[localStyles.metaText, localStyles.score]}>
                    ★ {scoreClamped.toFixed(1)}
                  </Text>
                </>
              )}
            </View>
          )}

          {(visibleChips.length > 0 || (!tagsExpanded && moreTags > 0)) ? (
            <View
              style={[
                localStyles.tagsContainer,
                !tagsExpanded ? localStyles.tagsContainerCollapsed : null,
              ]}
            >
              <View style={localStyles.tagsRow}>
                {visibleChips.map((c) => {
                  const mode = modeOf(c.type, c.name);
                  const isIncluded = mode === "include";
                  const isExcluded = mode === "exclude";

                  const chipStyle =
                    isIncluded ? localStyles.chipIncluded
                    : isExcluded ? localStyles.chipExcluded
                    : c.type === "artist" ? localStyles.chipArtist
                    : c.type === "parody" ? localStyles.chipParody
                    : c.type === "character" ? localStyles.chipCharacter
                    : c.type === "category" ? localStyles.chipCategory
                    : localStyles.chipTag;

                  const textStyle =
                    isIncluded ? localStyles.chipTextIncluded
                    : isExcluded ? localStyles.chipTextExcluded
                    : c.type === "artist" ? localStyles.chipTextArtist
                    : c.type === "parody" ? localStyles.chipTextParody
                    : c.type === "character" ? localStyles.chipTextCharacter
                    : c.type === "category" ? localStyles.chipTextCategory
                    : localStyles.chipTextTag;

                  return (
                    <Pressable
                      key={`${c.type}:${c.name}`}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        const item = { type: c.type as any, name: c.name };
                        if (mode === "include") {
                          // skip "exclude" state — go straight back to none
                          cycle(item);
                          cycle(item);
                        } else if (!mode) {
                          cycle(item);
                        }
                        // if "exclude" (set from tags page) — do nothing on card press
                      }}
                      style={({ pressed }) => [
                        localStyles.tagChip,
                        chipStyle,
                        pressed && { opacity: 0.75 },
                      ]}
                    >
                      <Text style={[localStyles.tagText, textStyle]} numberOfLines={1}>
                        {c.name}
                      </Text>
                    </Pressable>
                  );
                })}

                {tagsExpanded && chips.length > 0 && (
                  <Pressable
                    onPress={() => setTagsExpanded(false)}
                    style={({ pressed }) => [
                      localStyles.tagChip,
                      localStyles.tagChipCollapse,
                      pressed ? { opacity: 0.85 } : null,
                    ]}
                  >
                    <Text style={localStyles.tagTextMore}>▲</Text>
                  </Pressable>
                )}

                {!tagsExpanded && moreTags > 0 && (
                  <Pressable
                    onPress={() => setTagsExpanded(true)}
                    style={({ pressed }) => [
                      localStyles.tagChip,
                      localStyles.tagChipMore,
                      pressed ? { opacity: 0.9 } : null,
                    ]}
                  >
                    <Text style={localStyles.tagTextMore}>+{moreTags}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          ) : (
            <View style={localStyles.tagsRow}>
              <View style={[localStyles.tagChip, localStyles.tagChipLoading]}>
                <View style={localStyles.loadingRow}>
                  <Text style={localStyles.tagTextMore}>{collectingInfoText}</Text>
                  <ActivityIndicator
                    size="small"
                    color="rgba(255,255,255,0.55)"
                    style={{ marginLeft: 6, transform: [{ scale: 0.58 }], marginTop: 3 }}
                  />
                </View>
              </View>
            </View>
          )}
        </View>
      </Pressable>

    </>
  );
}

const localStyles = StyleSheet.create({
  card: {
    backgroundColor: "transparent",
    overflow: "visible",
  },
  webTransition: {
    transitionProperty: "opacity",
    transitionDuration: "140ms",
    transitionTimingFunction: "ease-out",
  } as any,
  cardHoverDim: {
    opacity: 0.88,
  },
  cardPressed: {
    opacity: 0.92,
  },
  coverBlacklistedDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0)",
  },
  blacklistNotice: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    minHeight: 26,
    borderRadius: 8,
    paddingHorizontal: 8,
    backgroundColor: "rgba(0,0,0,0.62)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  blacklistNoticeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 13,
  },
  imageWrap: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#111",
  },
  newBadge: {
    position: "absolute",
    left: 8,
    top: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "#FF3B30",
  },
  newBadgeText: {
    color: "#FFFFFF",
    fontWeight: "900",
    fontSize: 11,
    letterSpacing: 0.3,
  },
  infoBlock: {
    paddingTop: 8,
    paddingHorizontal: 4,
    paddingBottom: 4,
    gap: 5,
  },
  title: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 12,
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },
  metaText: {
    color: "rgba(255,255,255,0.50)",
    fontWeight: "600",
    fontSize: 11,
    lineHeight: 13,
  },
  score: {
    color: "#FFD166",
  },
  dot: {
    width: 2,
    height: 2,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  tagsContainer: {
    position: "relative",
  },
  tagsContainerCollapsed: {},
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  tagChip: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    maxWidth: "100%",
  },
  tagChipMore: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderColor: "rgba(255,255,255,0.22)",
  },
  tagChipCollapse: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderColor: "rgba(255,255,255,0.22)",
  },
  tagChipLoading: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.12)",
  },
  tagText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 10,
    fontWeight: "600",
    lineHeight: 12,
    maxWidth: 120,
  },
  tagTextMore: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 10,
    fontWeight: "700",
    lineHeight: 12,
  },
  chipArtist: {
    backgroundColor: "rgba(182, 99, 255, 0.14)",
    borderColor: "rgba(182, 99, 255, 0.32)",
  },
  chipTextArtist: { color: "rgba(222, 188, 255, 0.92)" },
  chipParody: {
    backgroundColor: "rgba(255, 77, 145, 0.14)",
    borderColor: "rgba(255, 77, 145, 0.32)",
  },
  chipTextParody: { color: "rgba(255, 199, 222, 0.92)" },
  chipCharacter: {
    backgroundColor: "rgba(54, 210, 255, 0.14)",
    borderColor: "rgba(54, 210, 255, 0.30)",
  },
  chipTextCharacter: { color: "rgba(186, 244, 255, 0.92)" },
  chipCategory: {
    backgroundColor: "rgba(255, 209, 102, 0.14)",
    borderColor: "rgba(255, 209, 102, 0.30)",
  },
  chipTextCategory: { color: "rgba(255, 236, 186, 0.92)" },
  chipTag: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.18)",
  },
  chipTextTag: { color: "rgba(255,255,255,0.78)" },
  chipIncluded: {
    backgroundColor: "rgba(34,197,94,0.22)",
    borderColor: "rgba(34,197,94,0.55)",
  },
  chipTextIncluded: { color: "rgba(134,239,172,0.95)" },
  chipExcluded: {
    backgroundColor: "rgba(239,68,68,0.18)",
    borderColor: "rgba(239,68,68,0.50)",
  },
  chipTextExcluded: { color: "rgba(252,165,165,0.95)" },
});

const dl = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 8,
    top: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 10,
    maxWidth: "92%",
  },
  overlayText: { color: "#fff", fontSize: 11, fontWeight: "800" },
});
