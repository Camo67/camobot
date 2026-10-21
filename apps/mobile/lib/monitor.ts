import { readBoundedJsonResponse } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { isLanOrLocalHost } from "./endpoint";
import { t } from "./i18n";

/**
 * A self-hosted fleet monitor: one JSON status for apps, agents and machines.
 * The address and bearer token stay on this device in SecureStore.
 */
export const MONITOR_URL_KEY = "rakazo.monitor-url";
export const MONITOR_TOKEN_KEY = "rakazo.monitor-token";
export const MONITOR_REFRESH_MS = 30_000;
const MONITOR_TIMEOUT_MS = 10_000;
const MAX_MONITOR_RESPONSE_BYTES = 512 * 1024;

export type MonitorState = "up" | "degraded" | "down" | "unknown" | "disabled";

export type MonitorApp = {
  name: string;
  kind: string;
  state: MonitorState;
  enabled: boolean;
  latency_ms: number | null;
  uptime_pct: number | null;
  error: string | null;
  last_checked: number | null;
};

export type MonitorStatus = {
  generated_at: number;
  summary: Record<MonitorState, number>;
  clients: { client: string; apps: MonitorApp[] }[];
  agents: { name: string; active: string; sub: string }[];
  handovers: { open: number; total: number };
  machines: { name: string; online: boolean; last_seen: string | null; os?: string }[];
};

export type MonitorSettings = { url: string; token: string };

export type MonitorResult =
  | { ok: true; status: MonitorStatus }
  | { ok: false; error: string; unauthorized?: boolean };

export function normalizeMonitorUrl(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: t("Enter a server URL") };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: t("That doesn’t look like a URL") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: t("Use an http or https URL") };
  }
  if (!parsed.hostname) return { ok: false, error: t("That URL is missing a host") };
  // The token travels in a header: plain HTTP is only acceptable on a private network.
  if (parsed.protocol === "http:" && !isLanOrLocalHost(parsed.hostname)) {
    return {
      ok: false,
      error: t("Public servers need https://. HTTP only works on your local network."),
    };
  }
  return { ok: true, url: `${parsed.protocol}//${parsed.host}` };
}

export async function loadMonitorSettings(): Promise<MonitorSettings | null> {
  try {
    const [url, token] = await Promise.all([
      SecureStore.getItemAsync(MONITOR_URL_KEY),
      SecureStore.getItemAsync(MONITOR_TOKEN_KEY),
    ]);
    return url && token ? { url, token } : null;
  } catch {
    return null;
  }
}

export async function saveMonitorSettings(settings: MonitorSettings): Promise<void> {
  await SecureStore.setItemAsync(MONITOR_URL_KEY, settings.url);
  await SecureStore.setItemAsync(MONITOR_TOKEN_KEY, settings.token);
}

export async function fetchMonitorStatus(
  settings: MonitorSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<MonitorResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MONITOR_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${settings.url}/api/status`, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return { ok: false, unauthorized: true, error: t("The monitor rejected the token") };
    }
    if (!response.ok) return { ok: false, error: t("Could not reach the server") };
    const status = await readBoundedJsonResponse<MonitorStatus>(
      response,
      MAX_MONITOR_RESPONSE_BYTES,
      controller.signal,
    );
    if (!status || !Array.isArray(status.clients)) {
      return { ok: false, error: t("Something went wrong. Try again.") };
    }
    return { ok: true, status };
  } catch {
    return { ok: false, error: t("Could not reach the server") };
  } finally {
    clearTimeout(timer);
  }
}

type StatusTokens = {
  success: string;
  warning: string;
  destructive: string;
  mutedForeground: string;
};

export function monitorStateColor(state: string, tokens: StatusTokens): string {
  if (state === "up" || state === "active" || state === "online") return tokens.success;
  if (state === "degraded" || state === "activating") return tokens.warning;
  if (state === "down" || state === "failed" || state === "offline") return tokens.destructive;
  return tokens.mutedForeground;
}

/** "12 ms · 99.8%"; a down app shows its error instead. */
export function monitorAppDetail(app: MonitorApp): string {
  if (!app.enabled || app.state === "disabled") return t("Paused");
  if (app.state === "down") return app.error ?? t("Down");
  const parts: string[] = [];
  if (app.latency_ms != null) parts.push(`${Math.round(app.latency_ms)} ms`);
  if (app.uptime_pct != null) parts.push(`${app.uptime_pct.toFixed(1)}%`);
  return parts.join(" · ");
}

export function monitorSummary(status: MonitorStatus): string {
  return t("{up} up · {degraded} degraded · {down} down", {
    up: status.summary.up ?? 0,
    degraded: status.summary.degraded ?? 0,
    down: status.summary.down ?? 0,
  });
}
