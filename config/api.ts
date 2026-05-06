import { NativeModules, Platform } from "react-native";

/** Значение из .env (как задано) */
export const API_BASE_URL_RAW =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? "";

function isLanOrEmulatorPackagerHost(host: string): boolean {
  if (host === "10.0.2.2") return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function packagerHostFromScript(): string | null {
  try {
    const scriptURL = NativeModules?.SourceCode?.scriptURL as string | undefined;
    if (!scriptURL || typeof scriptURL !== "string") return null;
    const m = scriptURL.match(/^https?:\/\/([^/?#:]+)/);
    const host = m?.[1];
    if (!host || host === "localhost" || host === "127.0.0.1") return null;
    if (!isLanOrEmulatorPackagerHost(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * На физическом устройстве `127.0.0.1` / `localhost` в .env указывают на телефон, а не на ПК с Metro/API.
 * Подменяем на хост бандла (тот же LAN, что и у packager).
 */
export function resolveLoopbackToPackagerHost(raw: string): string {
  if (!raw) return raw;
  if (Platform.OS === "web") return raw;
  if (!__DEV__) return raw;
  if (!/(^|[/:])127\.0\.0\.1([/:]|$)/i.test(raw) && !/(^|[/:])localhost([/:]|$)/i.test(raw)) {
    return raw;
  }
  const host = packagerHostFromScript();
  if (!host) return raw;
  return raw.replace(/127\.0\.0\.1/gi, host).replace(/localhost/gi, host);
}

const RAW_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;
const RAW_OR_DEV_FALLBACK = RAW_BASE
  ? RAW_BASE
  : __DEV__
    ? "http://localhost:3000"
    : "";

/** URL для запросов к nhapp-api: на нативе в dev loopback заменяется на IP машины с Metro. */
export const API_BASE_URL: string = resolveLoopbackToPackagerHost(RAW_OR_DEV_FALLBACK);
export const API_TIMEOUT_MS = 10000;
