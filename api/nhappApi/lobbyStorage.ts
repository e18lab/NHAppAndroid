/**
 * Лобби устройств: WebSocket к комнате пользователя. Переподключение при обрыве и при возврате в приложение.
 */
import { API_BASE_URL } from "@/config/api";
import { applyStorageToLocal, notifyStorageApplied } from "./cloudStorage";

let ws: WebSocket | null = null;
let currentUserId: number | null = null;
let onOpenCallback: (() => void | Promise<void>) | null = null;

let lobbyCredentials: { userId: number; deviceId: string } | null = null;
let manualDisconnect = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wasEverConnected = false;

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (manualDisconnect || !lobbyCredentials || reconnectTimer) return;
  const delay = Math.min(30_000, Math.round(900 * Math.pow(1.55, reconnectAttempt)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openLobbyWebSocket();
  }, delay);
  notifyCloudStats();
}

function detachSocket(s: WebSocket): void {
  try {
    s.onopen = null as any;
    s.onmessage = null as any;
    s.onerror = null as any;
    s.onclose = null as any;
    s.close();
  } catch {}
}

let lobbyPeersCount = 0;
export type LobbyPeerDevice = { device_id: string; device_name: string | null };
let lobbyPeersDevices: LobbyPeerDevice[] = [];
const peersCountListeners = new Set<(n: number) => void>();
const peersDevicesListeners = new Set<(devices: LobbyPeerDevice[]) => void>();

export type LobbyLastSync = {
  at: number;
  fromDeviceId: string;
  keysCount: number;
  recipientCount: number;
};

let lobbyServerRttMs: number | null = null;
let lobbyLastSync: LobbyLastSync | null = null;
const cloudStatsListeners = new Set<() => void>();

let pingTimer: ReturnType<typeof setInterval> | null = null;
let pingSeq = 0;
let pendingPing: { id: number; t: number } | null = null;

function notifyCloudStats(): void {
  cloudStatsListeners.forEach((cb) => cb());
}

function stopLobbyPingLoop(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  pendingPing = null;
}

function startLobbyPingLoop(): void {
  stopLobbyPingLoop();
  const tick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = ++pingSeq;
    const t = Date.now();
    pendingPing = { id, t };
    try {
      ws.send(JSON.stringify({ type: "ping", id, t }));
    } catch {
      pendingPing = null;
    }
  };
  tick();
  pingTimer = setInterval(tick, 2000);
}

export function getLobbyServerRttMs(): number | null {
  return lobbyServerRttMs;
}

export function getLobbyLastSync(): LobbyLastSync | null {
  return lobbyLastSync;
}

export type LobbyConnectionUi = {
  status: "online" | "pending" | "offline_local";
  /** first — первое подключение; retry — сокет оборвался, идёт повтор. */
  phase: "first" | "retry";
  pingMs: number | null;
};

export function getLobbyConnectionUi(): LobbyConnectionUi {
  const open = ws != null && ws.readyState === WebSocket.OPEN;
  if (open) return { status: "online", phase: "first", pingMs: lobbyServerRttMs };
  if (lobbyCredentials != null && !manualDisconnect) {
    if (!wasEverConnected) return { status: "pending", phase: "first", pingMs: null };
    if (reconnectTimer != null || reconnectAttempt > 0) {
      return { status: "pending", phase: "retry", pingMs: null };
    }
    return { status: "offline_local", phase: "retry", pingMs: null };
  }
  return { status: "pending", phase: "first", pingMs: null };
}

/** Стабильная строка для useSyncExternalStore (нельзя возвращать новый объект из getSnapshot на каждый вызов). */
export function getLobbyConnectionSnap(): string {
  const u = getLobbyConnectionUi();
  return JSON.stringify([u.status, u.phase, u.pingMs]);
}

export function subscribeToLobbyCloudStats(cb: () => void): () => void {
  cloudStatsListeners.add(cb);
  cb();
  return () => cloudStatsListeners.delete(cb);
}

let lastReceivedFromLobbyAt = 0;
let lastSentAt = 0;
let lastReceivedAt = 0;
const roleListeners = new Set<() => void>();

function setPeersCount(count: number): void {
  if (lobbyPeersCount === count) return;
  lobbyPeersCount = count;
  peersCountListeners.forEach((cb) => cb(count));
}

function notifyRoleChange(): void {
  roleListeners.forEach((cb) => cb());
}

function getLobbyWsUrl(userId: number, deviceId: string): string {
  const base = API_BASE_URL || "";
  const wsScheme = base.startsWith("https") ? "wss" : "ws";
  const host = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const params = new URLSearchParams({ userId: String(userId), deviceId });
  return `${wsScheme}://${host}/lobby?${params.toString()}`;
}

function onMessage(event: { data?: string | Blob }) {
  try {
    const raw = typeof event.data === "string" ? event.data : null;
    if (!raw) return;
    const msg = JSON.parse(raw) as {
      type?: string;
      storage?: Record<string, unknown>;
      count?: number;
      devices?: LobbyPeerDevice[];
      id?: number;
      t?: number;
      lastSync?: LobbyLastSync | null;
    };
    if (msg.type === "pong" && typeof msg.id === "number") {
      if (pendingPing && pendingPing.id === msg.id) {
        lobbyServerRttMs = Date.now() - pendingPing.t;
        pendingPing = null;
        notifyCloudStats();
      }
      return;
    }
    if (msg.type === "storage" && msg.storage && typeof msg.storage === "object") {
      lastReceivedFromLobbyAt = Date.now();
      lastReceivedAt = Date.now();
      notifyRoleChange();
      void applyStorageToLocal(msg.storage)
        .then(() => notifyStorageApplied())
        .catch((e) => console.warn("[lobby] apply storage:", e));
    }
    if (msg.type === "peers") {
      if (typeof msg.count === "number") setPeersCount(msg.count);
      if (Array.isArray(msg.devices)) {
        lobbyPeersDevices = msg.devices;
        peersDevicesListeners.forEach((cb) => cb(lobbyPeersDevices));
      }
      if (msg.lastSync === null) {
        lobbyLastSync = null;
      } else if (msg.lastSync && typeof msg.lastSync === "object") {
        const ls = msg.lastSync;
        if (typeof ls.at === "number" && typeof ls.fromDeviceId === "string") {
          lobbyLastSync = {
            at: ls.at,
            fromDeviceId: ls.fromDeviceId,
            keysCount: typeof ls.keysCount === "number" ? ls.keysCount : 0,
            recipientCount: typeof ls.recipientCount === "number" ? ls.recipientCount : 0,
          };
        }
      }
      notifyCloudStats();
    }
  } catch (e) {
    console.warn("[lobby] message parse error:", e);
  }
}

function handleSocketClosed(socket: WebSocket): void {
  if (ws !== socket) return;
  ws = null;
  stopLobbyPingLoop();
  lobbyServerRttMs = null;
  lobbyLastSync = null;
  setPeersCount(0);
  lobbyPeersDevices = [];
  peersDevicesListeners.forEach((cb) => cb([]));
  notifyCloudStats();
  if (manualDisconnect || !lobbyCredentials) return;
  scheduleReconnect();
}

function openLobbyWebSocket(): void {
  if (!lobbyCredentials || manualDisconnect) return;
  const { userId, deviceId } = lobbyCredentials;

  if (ws && ws.readyState === WebSocket.OPEN) return;

  if (ws) detachSocket(ws);
  ws = null;

  notifyCloudStats();

  try {
    const url = getLobbyWsUrl(userId, deviceId);
    const socket = new WebSocket(url);
    ws = socket;
    socket.onmessage = onMessage;
    socket.onopen = () => {
      if (ws !== socket) return;
      reconnectAttempt = 0;
      clearReconnectTimer();
      wasEverConnected = true;
      startLobbyPingLoop();
      notifyCloudStats();
      void onOpenCallback?.();
    };
    socket.onclose = () => handleSocketClosed(socket);
    socket.onerror = () => {};
  } catch (e) {
    console.warn("[lobby] connect error:", e);
    ws = null;
    if (!manualDisconnect && lobbyCredentials) scheduleReconnect();
    notifyCloudStats();
  }
}

/** Подключиться к лобби (сохраняет credentials для переподключения). */
export function connectLobby(userId: number, deviceId: string): void {
  if (!deviceId) {
    console.warn("[lobby] connectLobby called without deviceId");
    return;
  }
  manualDisconnect = false;
  lobbyCredentials = { userId, deviceId };
  currentUserId = userId;
  clearReconnectTimer();
  reconnectAttempt = 0;
  if (ws?.readyState === WebSocket.OPEN) return;
  openLobbyWebSocket();
}

/**
 * После возврата из фона: подключиться, если сокета нет; не рвать уже OPEN —
 * иначе при каждом `AppState` → `active` (в т.ч. после краткого `inactive`) ловим join/leave на сервере.
 */
export function resumeLobbyConnection(): void {
  if (manualDisconnect || !lobbyCredentials) return;
  if (ws?.readyState === WebSocket.OPEN) {
    clearReconnectTimer();
    reconnectAttempt = 0;
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING) return;
  clearReconnectTimer();
  reconnectAttempt = 0;
  if (ws) detachSocket(ws);
  ws = null;
  openLobbyWebSocket();
}

export function setLobbyOnOpen(cb: (() => void | Promise<void>) | null): void {
  onOpenCallback = cb;
}

export function disconnectLobby(): void {
  manualDisconnect = true;
  clearReconnectTimer();
  reconnectAttempt = 0;
  lobbyCredentials = null;
  wasEverConnected = false;
  stopLobbyPingLoop();
  lobbyServerRttMs = null;
  lobbyLastSync = null;
  if (ws) detachSocket(ws);
  ws = null;
  currentUserId = null;
  setPeersCount(0);
  lobbyPeersDevices = [];
  peersDevicesListeners.forEach((cb) => cb([]));
  notifyCloudStats();
}

export function getLobbyPeersDevices(): LobbyPeerDevice[] {
  return lobbyPeersDevices;
}

export function subscribeToLobbyPeersDevices(
  cb: (devices: LobbyPeerDevice[]) => void
): () => void {
  peersDevicesListeners.add(cb);
  cb(lobbyPeersDevices);
  return () => peersDevicesListeners.delete(cb);
}

export function getLobbyPeersCount(): number {
  return lobbyPeersCount;
}

export function subscribeToLobbyPeersCount(cb: (count: number) => void): () => void {
  peersCountListeners.add(cb);
  cb(lobbyPeersCount);
  return () => {
    peersCountListeners.delete(cb);
  };
}

export function sendStorageToLobby(storage: Record<string, string>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "storage", storage }));
    lastSentAt = Date.now();
    notifyRoleChange();
  } catch (e) {
    console.warn("[lobby] send error:", e);
  }
}

export function getLastReceivedFromLobbyAt(): number {
  return lastReceivedFromLobbyAt;
}

export function getLobbyRole(): "sender" | "receiver" | null {
  const now = Date.now();
  const windowMs = 5_000;
  if (now - lastSentAt <= windowMs && lastSentAt >= lastReceivedAt) return "sender";
  if (now - lastReceivedAt <= windowMs && lastReceivedAt >= lastSentAt) return "receiver";
  return null;
}

export function subscribeToLobbyRole(cb: () => void): () => void {
  roleListeners.add(cb);
  return () => roleListeners.delete(cb);
}

export function isLobbyConnected(): boolean {
  return ws != null && ws.readyState === WebSocket.OPEN;
}
