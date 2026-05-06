import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/lib/ThemeContext";
import { useI18n } from "@/lib/i18n/I18nContext";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  ApiError,
  autocompleteTags,
  getBlacklist,
  getMe,
  getUserProfile,
  updateBlacklist,
  updateProfile,
  uploadAvatar,
  type TagShort,
  type TagType,
} from "@/api/v2";
import { resolveImageUrl } from "@/api/v2/config";
import { isElectron, showOpenDialog } from "@/electron/bridge";
import { useToast } from "@/components/ToastProvider";
import { useTopBarAction } from "@/context/TopBarActionContext";
import { FilterDropdown, type SelectItem } from "@/components/uikit/FilterDropdown";
import { setBlacklistCache } from "@/lib/blacklistFilter";

interface ProfileEditFormData {
  username: string;
  email: string;
  about: string;
  favorite_tags: string;
  old_password?: string;
  new_password1?: string;
  new_password2?: string;
}

const InputField = React.memo(function InputField({
  label,
  value,
  onChangeText,
  icon,
  multiline,
  secureTextEntry,
  keyboardType,
  placeholder,
  uiSub,
  uiText,
  uiBorder,
  uiInputBg,
  inputRef,
  onFocus,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  icon: keyof typeof Feather.glyphMap;
  multiline?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "email-address";
  placeholder?: string;
  uiSub: string;
  uiText: string;
  uiBorder: string;
  uiInputBg: string;
  inputRef?: React.Ref<TextInput>;
  onFocus?: () => void;
}) {
  return (
    <View style={s.fieldWrap}>
      <View style={s.fieldLabelRow}>
        <Feather name={icon} size={13} color={uiSub} />
        <Text style={[s.fieldLabel, { color: uiSub }]}>{label}</Text>
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        style={[
          s.fieldInput,
          multiline && s.fieldTextArea,
          { backgroundColor: uiInputBg, color: uiText, borderColor: uiBorder },
        ]}
        placeholderTextColor={uiSub + "88"}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        numberOfLines={multiline ? 4 : 1}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
      />
    </View>
  );
});

const Skeleton = ({ style }: { style?: any }) => {
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[{ backgroundColor: "#FFFFFF14", borderRadius: 10 }, style, { opacity }]}
    />
  );
};

export default function ProfileEditScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const { setAction } = useTopBarAction();
  const { id, slug, avatarUrl } = useLocalSearchParams<{ id: string; slug?: string | string[]; avatarUrl?: string }>();
  const rawId = Array.isArray(id) ? id[0] : id;
  const rawSlug = Array.isArray(slug) ? slug[0] : slug;
  const userId = rawId != null && rawId !== "" ? String(rawId).trim() : "";
  const slugStr = rawSlug != null && rawSlug !== "" ? String(rawSlug).trim() : "";
  const initialAvatarUrl = (typeof avatarUrl === "string" && avatarUrl.trim()) ? avatarUrl.trim() : null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileEditFormData | null>(null);
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [currentAvatarUri, setCurrentAvatarUri] = useState<string | null>(null);
  const serverAvatarUriRef = useRef<string | null>(null);
  const baselineFormRef = useRef<ProfileEditFormData | null>(null);
  const baselineRemoveAvatarRef = useRef<boolean>(false);
  const baselineAvatarPathRef = useRef<string | null>(null);
  const baselineBlacklistIdsRef = useRef<Set<number>>(new Set());
  const blacklistLoadedOnceRef = useRef(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const lastFocusedRef = useRef<React.RefObject<TextInput | null> | null>(null);

  const [showBlacklist, setShowBlacklist] = useState(false);
  const [blacklistLoading, setBlacklistLoading] = useState(false);
  const [blacklistError, setBlacklistError] = useState(false);
  const [blacklistType, setBlacklistType] = useState<TagType>("tag");
  const [blacklistTags, setBlacklistTags] = useState<TagShort[]>([]);
  const [blacklistQuery, setBlacklistQuery] = useState("");
  const [blacklistSuggestions, setBlacklistSuggestions] = useState<TagShort[]>([]);
  const [blacklistSuggestLoading, setBlacklistSuggestLoading] = useState(false);
  const blacklistReqRef = useRef(0);
  const blacklistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visibleBlacklistSuggestions = useMemo(() => {
    if (blacklistTags.length === 0) return blacklistSuggestions;
    const picked = new Set<number>(blacklistTags.map((t) => t.id));
    return blacklistSuggestions.filter((s) => !picked.has(s.id));
  }, [blacklistSuggestions, blacklistTags]);

  const usernameRef = useRef<TextInput | null>(null);
  const emailRef = useRef<TextInput | null>(null);
  const aboutRef = useRef<TextInput | null>(null);
  const favTagsRef = useRef<TextInput | null>(null);
  const oldPassRef = useRef<TextInput | null>(null);
  const newPass1Ref = useRef<TextInput | null>(null);
  const newPass2Ref = useRef<TextInput | null>(null);
  const blacklistInputRef = useRef<TextInput | null>(null);

  const blacklistTypeItems: SelectItem[] = useMemo(
    () => [
      { value: "tag", label: "Tag" },
      { value: "artist", label: "Artist" },
      { value: "character", label: "Character" },
      { value: "parody", label: "Parody" },
      { value: "group", label: "Group" },
      { value: "language", label: "Language" },
      { value: "category", label: "Category" },
    ],
    []
  );

  const runBlacklistSuggest = useCallback(
    async (q: string, typeValue: TagType, opts?: { silent?: boolean }) => {
      const my = ++blacklistReqRef.current;
      const silent = !!opts?.silent;
      if (!silent) setBlacklistSuggestLoading(true);
      try {
        const res = await autocompleteTags({ query: q, type: typeValue, limit: 15 });
        if (blacklistReqRef.current !== my) return;
        // Normalize to TagShort-like items we can add immediately.
        setBlacklistSuggestions(
          res.map((tag) => ({
            id: tag.id,
            name: tag.name,
            slug: "",
            type: tag.type as TagType,
            count: tag.count ?? 0,
          })) as any
        );
      } catch {
        if (blacklistReqRef.current === my) setBlacklistSuggestions([]);
      } finally {
        if (!silent && blacklistReqRef.current === my) setBlacklistSuggestLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (blacklistLoading) return;
    if (!showBlacklist) return;
    const q = blacklistQuery.trim();
    if (blacklistDebounceRef.current) clearTimeout(blacklistDebounceRef.current);
    blacklistDebounceRef.current = setTimeout(() => {
      runBlacklistSuggest(q, blacklistType);
    }, q ? 220 : 80);
    return () => {
      if (blacklistDebounceRef.current) clearTimeout(blacklistDebounceRef.current);
    };
  }, [blacklistQuery, blacklistType, blacklistLoading, runBlacklistSuggest, showBlacklist]);

  const scrollToInput = useCallback((ref: React.RefObject<TextInput | null>, extraOffset = 110) => {
    const input = ref.current as any;
    if (!input) return;

    // react-native-web / Electron: findNodeHandle is not supported.
    // Use DOM scrollIntoView when available.
    if (Platform.OS === "web") {
      const el = input?._node ?? input;
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      }
      return;
    }

    // Native: ensure focused input is above the keyboard.
    const node = input;
    (scrollRef.current as any)?.scrollResponderScrollNativeHandleToKeyboard?.(
      node,
      extraOffset,
      true
    );
  }, []);

  useEffect(() => {
    const onShow = (e: any) => {
      const h = e?.endCoordinates?.height;
      setKeyboardHeight(typeof h === "number" ? h : 0);
      // When keyboard appears, re-scroll to the last focused input.
      // This fixes the "first tap doesn't scroll" timing issue.
      const ref = lastFocusedRef.current;
      if (ref) {
        setTimeout(() => scrollToInput(ref), 30);
      }
    };
    const onHide = () => setKeyboardHeight(0);
    const subShow = Keyboard.addListener("keyboardDidShow", onShow);
    const subHide = Keyboard.addListener("keyboardDidHide", onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  const handleFocus = useCallback(
    (ref: React.RefObject<TextInput | null>, extraOffset?: number) => {
      lastFocusedRef.current = ref;
      // Try to scroll immediately (works when keyboard is already open),
      // and also after layout settles.
      scrollToInput(ref, extraOffset);
      setTimeout(() => scrollToInput(ref, extraOffset), 30);
    },
    [scrollToInput]
  );

  const toastForError = useCallback(
    (e: any): { title: string; message?: string } => {
      if (e instanceof ApiError) {
        const apiMsg = (e.message || "").trim();
        const bodyErr =
          e.body && typeof e.body === "object" && "error" in (e.body as any)
            ? String((e.body as any).error)
            : null;
        const known =
          bodyErr && bodyErr.toLowerCase().includes("avatar upload not yet implemented")
            ? t("toast.avatarUploadNotImplemented")
            : null;
        const msg = known || bodyErr || apiMsg || t("toast.httpErrorGeneric", { code: e.status });
        return {
          title: t("toast.httpErrorTitle", { code: e.status }),
          message: msg,
        };
      }
      return {
        title: t("toast.errorTitle"),
        message: e?.message ? String(e.message) : t("toast.genericFailure"),
      };
    },
    [t]
  );

  const ui = {
    bg: colors.bg,
    card: (colors as any).surfaceElevated ?? "#1a1d22",
    text: (colors as any).title ?? "#e6e7e9",
    sub: (colors as any).metaText ?? "#9ca3af",
    border: "#ffffff10",
    inputBg: "#ffffff08",
    accent: colors.accent ?? "#3b82f6",
    danger: "#ef4444",
    chipBg: "#ffffff0e",
    successBg: (colors.accent ?? "#3b82f6") + "18",
  };

  const loadForm = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await getMe();
      // about & favorite_tags are not in /user response — fetch from public profile
      let about = "";
      let favorite_tags = "";
      try {
        const pub = await getUserProfile(me.id, me.slug);
        about = pub.about ?? "";
        favorite_tags = pub.favorite_tags ?? "";
      } catch {}
      setForm({
        username: me.username ?? "",
        email: me.email ?? "",
        about,
        favorite_tags,
        old_password: "",
        new_password1: "",
        new_password2: "",
      });
      // Show current avatar from API (resolve relative path)
      if (me.avatar_url && !initialAvatarUrl) {
        const resolved = resolveImageUrl(me.avatar_url);
        serverAvatarUriRef.current = resolved;
        setCurrentAvatarUri(resolved);
      } else {
        serverAvatarUriRef.current = initialAvatarUrl;
      }
      setRemoveAvatar(false);
      // Baseline for "dirty" detection
      baselineFormRef.current = {
        username: me.username ?? "",
        email: me.email ?? "",
        about,
        favorite_tags,
        old_password: "",
        new_password1: "",
        new_password2: "",
      };
      baselineRemoveAvatarRef.current = false;
      baselineAvatarPathRef.current = null;
    } catch (e: any) {
      setError(
        e?.status === 401
          ? t("profile.edit.notLoggedIn") || "You are not logged in. Please log in first."
          : e?.message || "Failed to load profile"
      );
    } finally {
      setLoading(false);
    }
  }, [t, initialAvatarUrl]);

  const isDirty = useMemo(() => {
    if (!form) return false;
    const base = baselineFormRef.current;
    if (!base) return false;
    const fieldsChanged =
      form.username !== base.username ||
      form.email !== base.email ||
      form.about !== base.about ||
      form.favorite_tags !== base.favorite_tags ||
      (form.old_password ?? "") !== (base.old_password ?? "") ||
      (form.new_password1 ?? "") !== (base.new_password1 ?? "") ||
      (form.new_password2 ?? "") !== (base.new_password2 ?? "");
    const avatarChanged =
      removeAvatar !== baselineRemoveAvatarRef.current ||
      avatarPath !== baselineAvatarPathRef.current;
    const baseIds = baselineBlacklistIdsRef.current;
    const blacklistChanged = blacklistTags.some((t) => !baseIds.has(t.id)) ||
      [...baseIds].some((id) => !blacklistTags.some((t) => t.id === id));
    return fieldsChanged || avatarChanged || blacklistChanged;
  }, [form, removeAvatar, avatarPath, blacklistTags]);

  useEffect(() => {
    loadForm();
  }, [loadForm]);

  const updateForm = useCallback(
    (updates: Partial<ProfileEditFormData>) => {
      setForm((prev) => (prev ? { ...prev, ...updates } : null));
    },
    []
  );

  const pickImage = useCallback(async () => {
    if (isElectron()) {
      let defaultPath: string | undefined;
      try {
        defaultPath = (await (window as any).electron?.getPath?.("pictures")) ?? undefined;
      } catch {
        defaultPath = undefined;
      }
      const result = await showOpenDialog({
        title: t("profile.edit.changeAvatar"),
        ...(defaultPath ? { defaultPath } : {}),
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] },
        ],
        properties: ["openFile"],
      });
      if (!result?.canceled && result?.filePaths?.[0]) {
        const filePath = result.filePaths[0];
        setAvatarPath(filePath);
        setRemoveAvatar(false);
        const dataUrlResult = await (window as any).electron?.getFileAsDataUrl?.(filePath);
        if (dataUrlResult?.success && dataUrlResult?.dataUrl) {
          setCurrentAvatarUri(dataUrlResult.dataUrl);
        } else {
          setCurrentAvatarUri(null);
        }
      }
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        t("profile.edit.permissionTitle") || "Permission",
        t("profile.edit.permissionMessage") || "Gallery access is required to pick an avatar."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setAvatarPath(asset.uri);
      setCurrentAvatarUri(asset.uri);
      setRemoveAvatar(false);
    }
  }, [t]);

  const handleRemoveAvatar = useCallback(() => {
    setRemoveAvatar(true);
    setAvatarPath(null);
    setCurrentAvatarUri(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      // Blacklist diff (v2)
      const baseIds = baselineBlacklistIdsRef.current;
      const currIds = new Set<number>(blacklistTags.map((t) => t.id));
      const added: number[] = [];
      const removed: number[] = [];
      for (const id of currIds) if (!baseIds.has(id)) added.push(id);
      for (const id of baseIds) if (!currIds.has(id)) removed.push(id);

      await updateProfile({
        username: form.username || undefined,
        email: form.email || undefined,
        about: form.about || undefined,
        favorite_tags: form.favorite_tags || undefined,
        current_password: form.old_password || undefined,
        new_password: form.new_password1 || undefined,
        remove_avatar: removeAvatar || undefined,
      });

      if (!removeAvatar && avatarPath) {
        const fd = new FormData();
        const filename =
          avatarPath.split("/").pop() ||
          avatarPath.split("\\").pop() ||
          "avatar.jpg";
        const ext = filename.split(".").pop()?.toLowerCase() ?? "jpg";
        const mime =
          ext === "png"
            ? "image/png"
            : ext === "gif"
            ? "image/gif"
            : ext === "webp"
            ? "image/webp"
            : "image/jpeg";

        if (isElectron()) {
          const dataUrlResult = await (window as any).electron?.getFileAsDataUrl?.(
            avatarPath
          );
          if (dataUrlResult?.success && dataUrlResult?.dataUrl) {
            const res = await fetch(dataUrlResult.dataUrl);
            const blob = await res.blob();
            fd.append("avatar", blob, filename);
          } else {
            throw new Error("Electron: failed to read avatar file");
          }
        } else {
          fd.append("avatar", { uri: avatarPath, name: filename, type: mime } as any);
        }

        await uploadAvatar(fd);
      }

      if (added.length || removed.length) {
        await updateBlacklist({ added, removed });
        baselineBlacklistIdsRef.current = currIds;
        setBlacklistCache(blacklistTags);
      }

      setError(null);
      showToast({ type: "success", title: t("profile.edit.saved") });
      // Clear password fields after save and update baseline so "Save" disappears
      const clearedForm: ProfileEditFormData = {
        ...form,
        old_password: "",
        new_password1: "",
        new_password2: "",
      };
      setForm(clearedForm);
      baselineFormRef.current = clearedForm;
      // Avatar selection/removal is an action, not a persistent "dirty" state
      setAvatarPath(null);
      setRemoveAvatar(false);
      baselineAvatarPathRef.current = null;
      baselineRemoveAvatarRef.current = false;
    } catch (e: any) {
      // If avatar operation failed, roll UI back to the server avatar.
      if (removeAvatar || avatarPath) {
        setAvatarPath(null);
        setRemoveAvatar(false);
        setCurrentAvatarUri(serverAvatarUriRef.current);
      }
      const toast = toastForError(e);
      showToast({ type: "error", title: toast.title, message: toast.message });
      // Keep banner minimal (or empty) — toast is primary UX.
      setError(null);
    } finally {
      setSaving(false);
    }
  }, [form, removeAvatar, avatarPath, showToast, toastForError, t, blacklistTags]);

  const avatarUri = currentAvatarUri || (!removeAvatar ? initialAvatarUrl : null);
  const hasAvatar = Boolean(avatarUri);

  useEffect(() => {
    if (!showBlacklist) return;
    if (blacklistLoading) return;
    if (blacklistLoadedOnceRef.current) return;
    blacklistLoadedOnceRef.current = true;
    setBlacklistLoading(true);
    setBlacklistError(false);
    getBlacklist()
      .then((bl) => {
        const tags = Array.isArray(bl.tags) ? bl.tags : [];
        setBlacklistTags(tags);
        setBlacklistCache(tags);
        baselineBlacklistIdsRef.current = new Set(tags.map((t) => t.id));
      })
      .catch((e) => {
        setBlacklistError(true);
        const toast = toastForError(e);
        showToast({ type: "error", title: toast.title, message: toast.message });
      })
      .finally(() => setBlacklistLoading(false));
  }, [showBlacklist, blacklistLoading, showToast, toastForError]);

  useEffect(() => {
    if (!showBlacklist) return;
    // Autofocus the blacklist input when section opens (same UX as other inputs).
    if (Platform.OS === "web") return;
    const t = setTimeout(() => {
      blacklistInputRef.current?.focus?.();
      handleFocus(blacklistInputRef);
    }, 60);
    return () => clearTimeout(t);
  }, [showBlacklist, handleFocus]);

  useEffect(() => {
    // Must be called on every render (no conditional hooks).
    if (!form || loading) {
      setAction(null);
      return;
    }
    if (!isDirty) {
      setAction(null);
      return;
    }
    setAction({
      label: t("common.save"),
      onPress: handleSubmit,
      disabled: saving,
      kind: "primary",
    });
    return () => setAction(null);
  }, [form, loading, isDirty, saving, setAction, handleSubmit, t]);

  if (loading) {
    return (
      <View style={[s.container, { backgroundColor: ui.bg }]}>
        <Stack.Screen options={{ title: t("profile.edit.title") }} />
        <View style={s.loadingWrap}>
          <Skeleton style={{ width: 96, height: 96, borderRadius: 32, alignSelf: "center", marginBottom: 20 }} />
          <View style={[s.card, { backgroundColor: ui.card }]}>
            <Skeleton style={{ height: 16, width: "30%", marginBottom: 10 }} />
            <Skeleton style={{ height: 44, borderRadius: 12, marginBottom: 16 }} />
            <Skeleton style={{ height: 16, width: "25%", marginBottom: 10 }} />
            <Skeleton style={{ height: 44, borderRadius: 12, marginBottom: 16 }} />
            <Skeleton style={{ height: 16, width: "35%", marginBottom: 10 }} />
            <Skeleton style={{ height: 80, borderRadius: 12 }} />
          </View>
        </View>
      </View>
    );
  }

  if (error && !form) {
    return (
      <View style={[s.container, { backgroundColor: ui.bg }]}>
        <Stack.Screen options={{ title: t("profile.edit.title") }} />
        <View style={s.centered}>
          <View style={[s.errorCard, { backgroundColor: ui.card }]}>
            <Feather name="alert-circle" size={40} color={ui.danger} />
            <Text style={[s.errorCardTitle, { color: ui.text }]}>{error}</Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={() => router.back()}
                style={[s.outlineBtn, { borderColor: ui.border }]}
              >
                <Feather name="arrow-left" size={16} color={ui.text} />
                <Text style={[s.outlineBtnText, { color: ui.text }]}>{t("common.back")}</Text>
              </Pressable>
              <Pressable
                onPress={loadForm}
                style={[s.outlineBtn, { borderColor: ui.accent + "44", backgroundColor: ui.accent + "14" }]}
              >
                <Feather name="refresh-cw" size={16} color={ui.accent} />
                <Text style={[s.outlineBtnText, { color: ui.accent }]}>
                  {t("common.retry") || "Retry"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }

  if (!form) return null;

  return (
    <View style={[s.container, { backgroundColor: ui.bg }]}>
      <Stack.Screen
        options={{
          title: t("profile.edit.title"),
        }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          ref={scrollRef}
          style={s.scroll}
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom:
              16 +
              insets.bottom +
              keyboardHeight +
              (Platform.OS !== "web" && showBlacklist ? 120 : 0),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Banners */}
          {error ? (
            <View style={[s.banner, { backgroundColor: ui.danger + "18" }]}>
              <Feather name="alert-triangle" size={15} color={ui.danger} />
              <Text style={[s.bannerText, { color: ui.danger }]}>{error}</Text>
            </View>
          ) : null}

          {/* Avatar section */}
          <View style={[s.card, { backgroundColor: ui.card, alignItems: "center" }]}>
            <Pressable onPress={pickImage} style={s.avatarPressable}>
              <View style={[s.avatarCircle, { borderColor: ui.accent + "33" }]}>
                {hasAvatar ? (
                  <Image source={{ uri: avatarUri || "" }} style={s.avatarImg} />
                ) : (
                  <View style={[s.avatarPlaceholder, { backgroundColor: ui.inputBg }]}>
                    <Feather name="user" size={36} color={ui.sub} />
                  </View>
                )}
                <View style={[s.avatarOverlay, { backgroundColor: "#00000066" }]}>
                  <Feather name="camera" size={20} color="#fff" />
                </View>
              </View>
            </Pressable>
            <View style={s.avatarBtns}>
              <Pressable
                onPress={pickImage}
                style={({ pressed }) => [
                  s.avatarActionBtn,
                  { backgroundColor: ui.accent + "18", opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Feather name="upload" size={14} color={ui.accent} />
                <Text style={[s.avatarActionText, { color: ui.accent }]}>
                  {t("profile.edit.changeAvatar")}
                </Text>
              </Pressable>
              {hasAvatar && (
                <Pressable
                  onPress={handleRemoveAvatar}
                  style={({ pressed }) => [
                    s.avatarActionBtn,
                    { backgroundColor: ui.danger + "14", opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Feather name="trash-2" size={14} color={ui.danger} />
                  <Text style={[s.avatarActionText, { color: ui.danger }]}>
                    {t("profile.edit.removeAvatar")}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Profile info */}
          <View style={[s.card, { backgroundColor: ui.card }]}>
            <InputField
              label={t("profile.edit.username")}
              value={form.username}
              onChangeText={(v) => updateForm({ username: v })}
              icon="at-sign"
              uiSub={ui.sub}
              uiText={ui.text}
              uiBorder={ui.border}
              uiInputBg={ui.inputBg}
              inputRef={usernameRef}
              onFocus={() => handleFocus(usernameRef)}
            />
            <InputField
              label={t("profile.edit.email")}
              value={form.email}
              onChangeText={(v) => updateForm({ email: v })}
              icon="mail"
              keyboardType="email-address"
              uiSub={ui.sub}
              uiText={ui.text}
              uiBorder={ui.border}
              uiInputBg={ui.inputBg}
              inputRef={emailRef}
              onFocus={() => handleFocus(emailRef)}
            />
            <InputField
              label={t("profile.edit.about")}
              value={form.about}
              onChangeText={(v) => updateForm({ about: v })}
              icon="file-text"
              multiline
              uiSub={ui.sub}
              uiText={ui.text}
              uiBorder={ui.border}
              uiInputBg={ui.inputBg}
              inputRef={aboutRef}
              onFocus={() => handleFocus(aboutRef)}
            />
            <InputField
              label={t("profile.edit.favoriteTags")}
              value={form.favorite_tags}
              onChangeText={(v) => updateForm({ favorite_tags: v })}
              icon="tag"
              placeholder="tag1, tag2, ..."
              uiSub={ui.sub}
              uiText={ui.text}
              uiBorder={ui.border}
              uiInputBg={ui.inputBg}
              inputRef={favTagsRef}
              onFocus={() => handleFocus(favTagsRef)}
            />
          </View>

          {/* Blacklist (v2) */}
          <View style={[s.card, { backgroundColor: ui.card }]}>
            <Pressable
              onPress={() => setShowBlacklist((v) => !v)}
              style={s.passwordToggle}
            >
              <View style={[s.linkIcon, { backgroundColor: ui.chipBg }]}>
                <Feather name="shield" size={16} color={ui.accent} />
              </View>
              <Text style={[s.passwordToggleText, { color: ui.text }]}>
                {t("profile.edit.blacklist")}
              </Text>
              <Feather
                name={showBlacklist ? "chevron-up" : "chevron-down"}
                size={20}
                color={ui.sub}
              />
            </Pressable>

            {showBlacklist ? (
              <View style={{ marginTop: 16 }}>
                {blacklistLoading ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }}>
                    <ActivityIndicator size="small" color={ui.sub} />
                    <Text style={{ color: ui.sub, fontWeight: "700" }}>
                      {t("common.loading")}
                    </Text>
                  </View>
                ) : blacklistError ? (
                  <Pressable
                    onPress={() => {
                      blacklistLoadedOnceRef.current = false;
                      setBlacklistError(false);
                      setBlacklistTags([]);
                    }}
                    style={({ pressed }) => [
                      {
                        alignSelf: "flex-start",
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: ui.border,
                        marginBottom: 12,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Text style={{ color: ui.sub, fontWeight: "800" }}>
                      {t("common.retry")}
                    </Text>
                  </Pressable>
                ) : null}

                <View style={{ width: "100%" }}>
                  {/* Results first (full width), controls below */}
                  <View
                    style={{
                      width: "100%",
                      borderWidth: 1,
                      borderColor: ui.border,
                      borderRadius: 14,
                      overflow: "hidden",
                      backgroundColor: ui.card,
                      maxHeight: 260,
                      minHeight: 260,
                    }}
                  >
                    <ScrollView
                      keyboardShouldPersistTaps="handled"
                      nestedScrollEnabled
                      showsVerticalScrollIndicator
                      contentContainerStyle={{ padding: 12, paddingTop: 10 }}
                    >
                      {blacklistSuggestLoading ? (
                        <View style={{ gap: 10 }}>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <View key={`sk_${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                              <View style={{ flex: 1 }}>
                                <Skeleton style={{ height: 44, borderRadius: 12, width: "100%" }} />
                                <Skeleton style={{ height: 12, borderRadius: 8, width: "48%", marginTop: 8 }} />
                              </View>
                              <Skeleton style={{ height: 18, width: 18, borderRadius: 9 }} />
                            </View>
                          ))}
                        </View>
                      ) : visibleBlacklistSuggestions.length === 0 ? (
                        <Text style={{ color: ui.sub }}>
                          {blacklistQuery.trim()
                            ? "No results"
                            : (t("common.typeToSearch") || "Type to search")}
                        </Text>
                      ) : (
                        <View style={{ gap: 10 }}>
                          {visibleBlacklistSuggestions.map((it) => (
                            <Pressable
                              key={`${it.id}`}
                              onPress={() => {
                                setBlacklistTags((prev) => {
                                  if (prev.some((t) => t.id === it.id)) return prev;
                                  return [...prev, it];
                                });
                                setBlacklistQuery("");
                                // Keep list stable; remove the selected item immediately,
                                // then refresh the default list in background.
                                setBlacklistSuggestions((prev) => prev.filter((x) => x.id !== it.id));
                                setTimeout(() => runBlacklistSuggest("", blacklistType, { silent: true }), 0);
                                if (Platform.OS !== "web") Keyboard.dismiss();
                              }}
                              style={({ pressed }) => [
                                {
                                  borderRadius: 14,
                                  borderWidth: 1,
                                  borderColor: ui.border,
                                  backgroundColor: pressed ? "#ffffff0a" : ui.inputBg,
                                  paddingHorizontal: 12,
                                  paddingVertical: 10,
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: 10,
                                },
                              ]}
                            >
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: ui.text, fontWeight: "800" }} numberOfLines={1}>
                                  {it.name}
                                </Text>
                                <Text style={{ color: ui.sub, marginTop: 2 }} numberOfLines={1}>
                                  {String(it.type).toUpperCase()}{"  "}{it.count ?? 0}
                                </Text>
                              </View>
                              <Feather name="plus" size={18} color={ui.accent} />
                            </Pressable>
                          ))}
                        </View>
                      )}
                    </ScrollView>
                  </View>

                  <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 10 }}>
                    <View style={{ width: 120 }}>
                      <FilterDropdown
                        value={blacklistType}
                        onChange={(v) => {
                          setBlacklistType(v as TagType);
                          setBlacklistSuggestions([]);
                          const q = blacklistQuery.trim();
                          setTimeout(
                            () => runBlacklistSuggest(q, v as TagType, { silent: blacklistSuggestions.length > 0 }),
                            0
                          );
                        }}
                        options={blacklistTypeItems}
                        keepOpen
                        variant="outline"
                        width={120}
                        minWidth={120}
                        maxWidth={120}
                      />
                    </View>

                    <View style={{ flex: 1 }}>
                      <TextInput
                        ref={blacklistInputRef}
                        value={blacklistQuery}
                        onChangeText={setBlacklistQuery}
                        editable={!blacklistLoading}
                        placeholder={t("profile.blacklist.addPlaceholder")}
                        placeholderTextColor={ui.sub + "88"}
                        autoCapitalize="none"
                        autoCorrect={false}
                        onFocus={() => handleFocus(blacklistInputRef, 16)}
                        style={[
                          {
                            height: 44,
                            borderWidth: 1,
                            borderRadius: 12,
                            paddingHorizontal: 14,
                            fontSize: 15,
                            backgroundColor: ui.inputBg,
                            borderColor: ui.border,
                            color: ui.text,
                          },
                        ]}
                      />
                    </View>
                  </View>
                </View>

                <View style={{ marginTop: 12 }}>
                  {blacklistTags.length === 0 ? (
                    <Text style={{ color: ui.sub }}>
                      {t("profile.blacklist.empty") || "No blacklisted tags."}
                    </Text>
                  ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {blacklistTags.map((it) => (
                        <Pressable
                          key={`${it.id}`}
                          onPress={() =>
                            setBlacklistTags((prev) => prev.filter((x) => x.id !== it.id))
                          }
                          style={({ pressed }) => [
                            {
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 6,
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              borderRadius: 10,
                              borderWidth: 1,
                              borderColor: ui.border,
                              backgroundColor: pressed ? "#ffffff10" : ui.chipBg,
                            },
                          ]}
                        >
                          <View>
                            <Text style={{ color: ui.text, fontWeight: "700", fontSize: 13 }} numberOfLines={1}>
                              {it.name}
                            </Text>
                            <Text style={{ color: ui.sub, fontSize: 10, marginTop: 1 }} numberOfLines={1}>
                              {String(it.type).toUpperCase()}
                            </Text>
                          </View>
                          <Feather name="x" size={14} color={ui.sub} />
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              </View>
            ) : null}
          </View>

          {/* Password section */}
          <View style={[s.card, { backgroundColor: ui.card }]}>
            <Pressable
              onPress={() => setShowPasswords((v) => !v)}
              style={s.passwordToggle}
            >
              <View style={[s.linkIcon, { backgroundColor: ui.chipBg }]}>
                <Feather name="lock" size={16} color={ui.accent} />
              </View>
              <Text style={[s.passwordToggleText, { color: ui.text }]}>
                {t("profile.edit.changePassword")}
              </Text>
              <Feather
                name={showPasswords ? "chevron-up" : "chevron-down"}
                size={20}
                color={ui.sub}
              />
            </Pressable>
            {showPasswords && (
              <View style={{ marginTop: 16 }}>
                <InputField
                  label={t("profile.edit.oldPassword")}
                  value={form.old_password ?? ""}
                  onChangeText={(v) => updateForm({ old_password: v })}
                  icon="key"
                  secureTextEntry
                  uiSub={ui.sub}
                  uiText={ui.text}
                  uiBorder={ui.border}
                  uiInputBg={ui.inputBg}
                  inputRef={oldPassRef}
                  onFocus={() => handleFocus(oldPassRef)}
                />
                <InputField
                  label={t("profile.edit.newPassword")}
                  value={form.new_password1 ?? ""}
                  onChangeText={(v) => updateForm({ new_password1: v })}
                  icon="lock"
                  secureTextEntry
                  uiSub={ui.sub}
                  uiText={ui.text}
                  uiBorder={ui.border}
                  uiInputBg={ui.inputBg}
                  inputRef={newPass1Ref}
                  onFocus={() => handleFocus(newPass1Ref)}
                />
                <InputField
                  label={t("profile.edit.newPasswordAgain")}
                  value={form.new_password2 ?? ""}
                  onChangeText={(v) => updateForm({ new_password2: v })}
                  icon="lock"
                  secureTextEntry
                  uiSub={ui.sub}
                  uiText={ui.text}
                  uiBorder={ui.border}
                  uiInputBg={ui.inputBg}
                  inputRef={newPass2Ref}
                  onFocus={() => handleFocus(newPass2Ref)}
                />
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  loadingWrap: { flex: 1, padding: 16 },
  scroll: { flex: 1 },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 10,
  },
  bannerText: { fontSize: 13, fontWeight: "600", flex: 1 },

  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },

  // Avatar
  avatarPressable: { marginBottom: 14 },
  avatarCircle: {
    width: 100,
    height: 100,
    borderRadius: 32,
    borderWidth: 3,
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarPlaceholder: { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    opacity: 0,
  },
  avatarBtns: { flexDirection: "row", gap: 10, flexWrap: "wrap", justifyContent: "center" },
  avatarActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  avatarActionText: { fontWeight: "700", fontSize: 13 },

  // Fields
  fieldWrap: { marginBottom: 16 },
  fieldLabelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  fieldLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.3, textTransform: "uppercase" },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  fieldTextArea: { minHeight: 90, textAlignVertical: "top" },

  // Link card
  linkCard: { flexDirection: "row", alignItems: "center", gap: 14 },
  linkIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  linkTitle: { fontWeight: "700", fontSize: 15, marginBottom: 2 },
  linkSub: { fontSize: 12 },

  // Password
  passwordToggle: { flexDirection: "row", alignItems: "center", gap: 12 },
  passwordToggleText: { fontWeight: "700", fontSize: 15, flex: 1 },

  // Bottom bar removed (save is in top-right)

  errorCard: {
    borderRadius: 18,
    padding: 32,
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: 360,
  },
  errorCardTitle: { fontSize: 15, textAlign: "center", fontWeight: "600" },
  outlineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 12,
  },
  outlineBtnText: { fontWeight: "700", fontSize: 14 },
});
