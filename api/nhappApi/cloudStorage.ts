/**
 * Облачное хранилище пользователя (JSON), синхронизация с API.
 * Работает поверх AsyncStorage: ключи, не начинающиеся с @auth, синхронизируются.
 */
import { API_BASE_URL } from "@/config/api";
import { mergeValueForKey } from "@/api/nhappApi/storageMerge";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Application from "expo-application";

const STORAGE_PREFIX_EXCLUDE = "@auth"; // Не синхронизируем токены и т.п.

// Точные ключи, которые НИКОГДА не попадают в cloud sync — сессионные данные
const STORAGE_KEYS_EXCLUDE = new Set([
  "@v2.access_token",
  "@v2.refresh_token",
  "@nh.access_token",
  "@nh.refresh_token",
  /** CSRF одноразовый / привязан к сессии — в storage_json на сервере не нужен */
  "nh.csrf",
]);
const APP_VERSION_KEY = "@cloud.appVersion";
const APP_VERSION_VALUE =
  Constants.expoConfig?.version ??
  Application.nativeApplicationVersion ??
  Application.applicationVersion ??
  "unknown";

export type StorageResponse = {
  storage: Record<string, unknown>;
  storage_updated_at: string | null;
};

/** Загрузить облачное хранилище с сервера. */
export async function fetchCloudStorage(userId: number): Promise<StorageResponse> {
  const res = await fetch(`${API_BASE_URL}/api/users/me/storage?userId=${userId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Storage fetch failed: ${res.status}`);
  const data = (await res.json()) as { storage?: Record<string, unknown>; storage_updated_at?: string | null };
  const storage = (data.storage ?? {}) as Record<string, unknown>;
  return {
    storage,
    storage_updated_at: data.storage_updated_at ?? null,
  };
}

/** Отправить текущее локальное хранилище (без @auth) на сервер. */
export async function pushCloudStorage(
  userId: number,
  storage: Record<string, string>
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/users/me/storage`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": String(userId),
    },
    body: JSON.stringify({ storage }),
  });
  if (!res.ok) throw new Error(`Storage push failed: ${res.status}`);
}

/** Отметить пользователя онлайн (last_online_at + last_seen устройства). */
export async function touchOnline(userId: number, deviceId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/users/me/online`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": String(userId),
    },
    body: JSON.stringify({ deviceId }),
  });
}

/** Собрать из AsyncStorage все ключи, кроме исключённых по префиксу. */
export async function collectLocalStorageForSync(): Promise<Record<string, string>> {
  const keys = await AsyncStorage.getAllKeys();
  const toSync = keys.filter(
    (k) => !k.startsWith(STORAGE_PREFIX_EXCLUDE) && !STORAGE_KEYS_EXCLUDE.has(k)
  );
  if (toSync.length === 0) return { [APP_VERSION_KEY]: APP_VERSION_VALUE };
  const pairs = await AsyncStorage.multiGet(toSync);
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value != null) out[key] = value;
  }
  out[APP_VERSION_KEY] = APP_VERSION_VALUE;
  return out;
}

const MERGE_KEYS = new Set([
  "bookFavorites",
  "readHistory",
  "searchHistory",
  "bookFavoritesOnline.v1",
]);

/** Применить облачное хранилище к AsyncStorage (merge для избранного/истории; не трогаем @auth). */
export async function applyStorageToLocal(storage: Record<string, unknown>): Promise<void> {
  const remoteKeys = Object.keys(storage).filter(
    (k) => !k.startsWith(STORAGE_PREFIX_EXCLUDE) && !STORAGE_KEYS_EXCLUDE.has(k)
  );
  const readKeys = [...new Set([...remoteKeys, ...MERGE_KEYS])].filter(
    (k) => !k.startsWith(STORAGE_PREFIX_EXCLUDE) && !STORAGE_KEYS_EXCLUDE.has(k)
  );
  const pairs = readKeys.length ? await AsyncStorage.multiGet(readKeys) : [];
  const local = new Map(pairs);

  const toSet: [string, string][] = [];
  for (const k of remoteKeys) {
    const v = storage[k];
    const localStr = local.get(k) ?? null;
    if (MERGE_KEYS.has(k)) {
      toSet.push([k, mergeValueForKey(k, localStr, v)]);
    } else {
      toSet.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
    }
  }
  for (const k of MERGE_KEYS) {
    if (remoteKeys.includes(k)) continue;
    const loc = local.get(k);
    if (loc != null && loc !== "") toSet.push([k, loc]);
  }
  if (toSet.length === 0) return;
  await AsyncStorage.multiSet(toSet);
}

// ——— Live-синхронизация: подписка на применение облака + запрос пуша ———

const storageAppliedListeners: Array<() => void> = [];
let pushCallback: (() => void) | null = null;

/** Подписаться на событие «облачное хранилище применено к локальному». Перечитайте свои ключи из AsyncStorage. */
export function subscribeToStorageApplied(cb: () => void): () => void {
  storageAppliedListeners.push(cb);
  return () => {
    const i = storageAppliedListeners.indexOf(cb);
    if (i >= 0) storageAppliedListeners.splice(i, 1);
  };
}

/** Вызвать после applyStorageToLocal в sync — уведомляет подписчиков перечитать настройки. */
export function notifyStorageApplied(): void {
  storageAppliedListeners.forEach((l) => l());
}

/** Зарегистрировать callback для немедленного пуша (вызывается из useCloudStorageSync). */
export function setStoragePushCallback(cb: (() => void) | null): void {
  pushCallback = cb;
}

let lastLocalPushRequestAt = 0;

/** Запросить отправку локального хранилища в облако (после смены темы/языка и т.д.). Вызовет debounced push. */
export function requestStoragePush(): void {
  lastLocalPushRequestAt = Date.now();
  pushCallback?.();
}

/** Время последнего вызова requestStoragePush (чтобы не перезаписывать локальные изменения при pull). */
export function getLastLocalPushRequestAt(): number {
  return lastLocalPushRequestAt;
}
