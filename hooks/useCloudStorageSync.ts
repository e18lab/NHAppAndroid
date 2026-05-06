/**
 * Синхронизация через лобби: источник правды — лобби на беке. Данные приходят при подключении и по WebSocket.
 * Клиент только шлёт изменения в лобби; лобби рассылает остальным и раз в 10 с пишет в БД.
 */
import {
  touchOnline,
  collectLocalStorageForSync,
  setStoragePushCallback,
} from "@/api/nhappApi/cloudStorage";
import {
  connectLobby,
  disconnectLobby,
  resumeLobbyConnection,
  sendStorageToLobby,
  setLobbyOnOpen,
  getLastReceivedFromLobbyAt,
} from "@/api/nhappApi/lobbyStorage";
import { getDeviceId } from "@/utils/deviceId";
import { useOnlineMe } from "@/hooks/useOnlineMe";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

const PUSH_DEBOUNCE_MS = 900;
/** Не пушить, если только что получили storage из лобби (избегаем цикла). */
const SKIP_PUSH_AFTER_RECEIVE_MS = 4_000;

/** Запускает синхронизацию через лобби при авторизованном пользователе. */
export function useCloudStorageSync(): void {
  const me = useOnlineMe();

  const push = useCallback(async () => {
    if (!me?.id) return;
    if (Date.now() - getLastReceivedFromLobbyAt() < SKIP_PUSH_AFTER_RECEIVE_MS) return;
    try {
      const storage = await collectLocalStorageForSync();
      sendStorageToLobby(storage);
    } catch (e) {
      console.warn("[cloudStorage] push to lobby failed:", e);
    }
  }, [me?.id]);

  const flushToLobby = useCallback(async () => {
    if (!me?.id) return;
    try {
      const storage = await collectLocalStorageForSync();
      sendStorageToLobby(storage);
    } catch (e) {
      console.warn("[cloudStorage] background flush failed:", e);
    }
  }, [me?.id]);

  const pushRef = useRef(push);
  pushRef.current = push;
  const flushRef = useRef(flushToLobby);
  flushRef.current = flushToLobby;

  useEffect(() => {
    if (!me?.id) {
      setLobbyOnOpen(null);
      disconnectLobby();
      setStoragePushCallback(null);
      return;
    }

    setLobbyOnOpen(async () => {
      try {
        const deviceId = await getDeviceId();
        await touchOnline(me.id!, deviceId);
      } catch (_) {}
    });

    getDeviceId()
      .then(async (deviceId) => {
        try {
          await touchOnline(me.id!, deviceId);
        } catch (_) {}
        connectLobby(me.id!, deviceId);
      })
      .catch(() => {});

    let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    setStoragePushCallback(() => {
      if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
      pushDebounceTimer = setTimeout(() => {
        pushDebounceTimer = null;
        pushRef.current();
      }, PUSH_DEBOUNCE_MS);
    });

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        if (pushDebounceTimer) {
          clearTimeout(pushDebounceTimer);
          pushDebounceTimer = null;
        }
        void flushRef.current();
      }
      if (state === "active") {
        resumeLobbyConnection();
      }
    });

    return () => {
      setLobbyOnOpen(null);
      disconnectLobby();
      setStoragePushCallback(null);
      if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
      appStateSub.remove();
    };
  }, [me?.id, me?.username, push, flushToLobby]);
}
