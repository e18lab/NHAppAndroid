import { getMe, hasSession } from "@/api/v2";
import type { Me } from "@/api/v2";
import { getAuthStorageReady } from "@/api/v2/client";
import { API_BASE_URL } from "@/config/api";
import { getDeviceId, getDeviceName } from "@/utils/deviceId";
import * as Application from "expo-application";
import { useEffect, useSyncExternalStore } from "react";

let meSnapshot: Me | null = null;
const listeners = new Set<() => void>();
const appVersion = Application.nativeApplicationVersion ?? "unknown";

function notify() {
  for (const l of listeners) l();
}

let loadOnceStarted = false;

async function loadMeOnce() {
  try {
    await getAuthStorageReady();
    if (!(await hasSession())) {
      meSnapshot = null;
      notify();
      return;
    }
    meSnapshot = await getMe();
  } catch (err) {
    if (__DEV__) {
      console.warn("[useOnlineMe] Failed to load me:", err);
    }
    // Не затираем профиль, если useAuthBridge уже успел синхронизировать (сеть могла упасть только здесь).
    if (!(await hasSession())) {
      meSnapshot = null;
    }
  }
  notify();
}

function ensureLoadStarted() {
  if (loadOnceStarted) return;
  loadOnceStarted = true;
  void loadMeOnce();
}

/** Синхронизация с useAuthBridge после логина / логаута / обновления профиля. */
export function syncOnlineMeFromAuth(me: Me | null): void {
  meSnapshot = me;
  notify();
}

export function useOnlineMe(): Me | null {
  const me = useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      ensureLoadStarted();
      return () => listeners.delete(onStoreChange);
    },
    () => meSnapshot,
    () => null
  );

  useEffect(() => {
    ensureLoadStarted();
  }, []);

  useEffect(() => {
    if (!me?.id || !me.username) return;

    const controller = new AbortController();

    Promise.all([getDeviceId(), getDeviceName()])
      .then(([deviceId, deviceName]) => {
        if (controller.signal.aborted) return;
        return fetch(`${API_BASE_URL}/api/users/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: me.id,
            username: me.username,
            deviceId,
            deviceName,
            appVersion,
          }),
          signal: controller.signal,
        });
      })
      .then((r) => r?.ok)
      .catch(() => {});

    return () => controller.abort();
  }, [me?.id, me?.username]);

  return me;
}
