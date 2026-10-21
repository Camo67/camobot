import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));
vi.mock("./i18n", () => ({
  t: (text: string, values?: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));

import type { MonitorApp, MonitorStatus } from "./monitor";
import {
  fetchMonitorStatus,
  loadMonitorSettings,
  MONITOR_TOKEN_KEY,
  monitorAppDetail,
  monitorStateColor,
  monitorSummary,
  normalizeMonitorUrl,
  saveMonitorSettings,
} from "./monitor";

const STATUS: MonitorStatus = {
  generated_at: 1,
  summary: { up: 3, degraded: 1, down: 2, unknown: 0, disabled: 1 },
  clients: [{ client: "Acme", apps: [] }],
  agents: [],
  handovers: { open: 2, total: 5 },
  machines: [],
};

function app(overrides: Partial<MonitorApp>): MonitorApp {
  return {
    name: "Web",
    kind: "http",
    state: "up",
    enabled: true,
    latency_ms: 12.4,
    uptime_pct: 99.84,
    error: null,
    last_checked: 1,
    ...overrides,
  };
}

describe("monitor", () => {
  beforeEach(() => store.clear());

  it("accepts private http and any https, rejects public http", () => {
    expect(normalizeMonitorUrl("100.64.1.2:8790/")).toEqual({
      ok: true,
      url: "http://100.64.1.2:8790",
    });
    expect(normalizeMonitorUrl("https://monitor.example.com/x")).toEqual({
      ok: true,
      url: "https://monitor.example.com",
    });
    expect(normalizeMonitorUrl("http://monitor.example.com").ok).toBe(false);
    expect(normalizeMonitorUrl("ftp://10.0.0.1").ok).toBe(false);
    expect(normalizeMonitorUrl(" ").ok).toBe(false);
  });

  it("keeps the address and token in SecureStore", async () => {
    expect(await loadMonitorSettings()).toBeNull();
    await saveMonitorSettings({ url: "http://10.0.0.2:8790", token: "placeholder" });
    expect(store.get(MONITOR_TOKEN_KEY)).toBe("placeholder");
    expect(await loadMonitorSettings()).toEqual({
      url: "http://10.0.0.2:8790",
      token: "placeholder",
    });
  });

  it("sends the bearer token and returns the status", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(STATUS), { status: 200 }));
    const result = await fetchMonitorStatus(
      { url: "http://10.0.0.2:8790", token: "placeholder" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, status: STATUS });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://10.0.0.2:8790/api/status");
    expect(init.headers).toEqual({ authorization: "Bearer placeholder" });
  });

  it("flags a rejected token and an unreachable server", async () => {
    const settings = { url: "http://10.0.0.2:8790", token: "wrong" };
    const unauthorized = await fetchMonitorStatus(
      settings,
      (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    );
    expect(unauthorized).toMatchObject({ ok: false, unauthorized: true });
    const offline = await fetchMonitorStatus(settings, (async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch);
    expect(offline).toEqual({ ok: false, error: "Could not reach the server" });
  });

  it("formats rows and colors", () => {
    expect(monitorAppDetail(app({}))).toBe("12 ms · 99.8%");
    expect(monitorAppDetail(app({ state: "down", error: "connection refused" }))).toBe(
      "connection refused",
    );
    expect(monitorAppDetail(app({ state: "disabled", enabled: false }))).toBe("Paused");
    const tokens = { success: "g", warning: "y", destructive: "r", mutedForeground: "m" };
    expect(monitorStateColor("up", tokens)).toBe("g");
    expect(monitorStateColor("degraded", tokens)).toBe("y");
    expect(monitorStateColor("failed", tokens)).toBe("r");
    expect(monitorStateColor("disabled", tokens)).toBe("m");
    expect(monitorSummary(STATUS)).toBe("3 up · 1 degraded · 2 down");
  });
});
