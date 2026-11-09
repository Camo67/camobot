import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Context, Model } from "@earendil-works/pi-ai";
import { localProvider, LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { reliableModelStream } from "./pi-runtime-stream.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MESSAGE } from "./pi-runtime-stream.js";
import { localModelFetch } from "./local-model-fetch.js";

vi.mock("./local-model-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-model-fetch.js")>();
  return { ...actual, localModelFetch: vi.fn(actual.localModelFetch) };
});
const localModelFetchMock = vi.mocked(localModelFetch);

/**
 * Integrated regression for the local-model transport: reliableModelStream must
 * route LOCAL_PROVIDER_ID models through localModelFetch (undici headers/body
 * timeouts disabled) so the SDK's own timeoutMs deadline, the caller's signal,
 * and the runtime idle watchdog govern - not undici's hidden 300s defaults.
 */

const CHUNK = (content: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
  })}\n\n`;

type Behavior =
  | { kind: "ok" }
  | { kind: "delayHeaders"; delayMs: number }
  | { kind: "stallBody" }
  | { kind: "fail500" };

let server: Server;
let baseUrl: string;
let behavior: Behavior = { kind: "ok" };
let requestCount = 0;
let responseClosedCount = 0;
const pendingTimers: ReturnType<typeof setTimeout>[] = [];

beforeEach(async () => {
  requestCount = 0;
  responseClosedCount = 0;
  localModelFetchMock.mockClear();
  server = createServer((req, res) => {
    requestCount += 1;
    // res "close" fires when the underlying connection is terminated - the
    // actual client-abort/timeout signal (req "close" only means the request
    // body finished arriving).
    res.on("close", () => {
      responseClosedCount += 1;
    });
    req.resume();
    const b = behavior;
    const respond = () => {
      if (b.kind === "fail500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(CHUNK("hi", null));
      if (b.kind === "stallBody") return; // headers sent, body never continues
      res.write(CHUNK("", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (b.kind === "delayHeaders") pendingTimers.push(setTimeout(respond, b.delayMs));
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const t of pendingTimers.splice(0)) clearTimeout(t);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function localModel(): Model<"openai-completions"> {
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "test-local-model");
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", baseUrl);
  const provider = localProvider();
  if (!provider) throw new Error("local provider unavailable");
  const model = provider.getModels()[0]!;
  expect(model.provider).toBe(LOCAL_PROVIDER_ID);
  return model;
}

function localModels() {
  const models = createModels();
  const provider = localProvider();
  if (!provider) throw new Error("local provider unavailable");
  models.setProvider(provider);
  return models;
}

const context = (): Context =>
  ({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }) as unknown as Context;

describe("local model transport (integrated)", () => {
  it("idle-aborts a stalled streamed body and closes the connection, with no caller timer", async () => {
    behavior = { kind: "stallBody" };
    vi.stubEnv("MODEL_STREAM_IDLE_TIMEOUT_MS", "1000");
    const model = localModel();
    const stream = reliableModelStream(localModels(), model, context(), {
      maxRetries: 0,
      timeoutMs: 30_000,
    } as never, 4096);
    const pending = stream.result();
    // Headers landed, body stalled: connection open and NOT closed before the abort.
    await vi.waitFor(() => expect(requestCount).toBe(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 300)); // well under the 1000ms idle bound
    expect(responseClosedCount).toBe(0);
    const result = await pending;
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(MODEL_STREAM_IDLE_TIMEOUT_MESSAGE);
    expect(localModelFetchMock).toHaveBeenCalled();
    // The idle abort must actually terminate the connection.
    await vi.waitFor(() => expect(responseClosedCount).toBeGreaterThan(0), { timeout: 2000 });
  }, 15_000);

  it("honours caller cancellation before response headers", async () => {
    behavior = { kind: "delayHeaders", delayMs: 5_000 };
    const model = localModel();
    const controller = new AbortController();
    const cancelTimer = setTimeout(() => controller.abort(new Error("user cancel")), 400);
    const started = Date.now();
    const stream = reliableModelStream(localModels(), model, context(), {
      maxRetries: 0,
      timeoutMs: 30_000,
      signal: controller.signal,
    } as never, 4096);
    const pending = stream.result();
    // Request in flight, pre-headers, connection not yet closed.
    await vi.waitFor(() => expect(requestCount).toBe(1), { timeout: 2000 });
    expect(responseClosedCount).toBe(0);
    const result = await pending;
    clearTimeout(cancelTimer);
    const elapsed = Date.now() - started;
    expect(result.stopReason).not.toBe("stop");
    expect(elapsed).toBeLessThan(2500);
    // Cancellation must actually terminate the connection.
    await vi.waitFor(() => expect(responseClosedCount).toBeGreaterThan(0), { timeout: 2000 });
  }, 15_000);

  it("lets a caller timeoutMs override the env default as the pre-headers deadline", async () => {
    behavior = { kind: "delayHeaders", delayMs: 2500 };
    vi.stubEnv("MODEL_STREAM_TIMEOUT_MS", "30000");
    const model = localModel();
    const started = Date.now();
    const stream = reliableModelStream(localModels(), model, context(), {
      maxRetries: 0,
      timeoutMs: 1200,
    } as never, 4096);
    const result = await stream.result();
    const elapsed = Date.now() - started;
    expect(result.stopReason).toBe("error");
    expect(String(result.errorMessage)).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(2400);
  }, 15_000);

  it("makes exactly one attempt with maxRetries 0, and retries=2 means three attempts on HTTP 500", async () => {
    behavior = { kind: "fail500" };
    const model = localModel();
    const once = await reliableModelStream(localModels(), model, context(), {
      maxRetries: 0,
      timeoutMs: 10_000,
    } as never, 4096).result();
    expect(once.stopReason).toBe("error");
    expect(requestCount).toBe(1);

    const thrice = await reliableModelStream(localModels(), model, context(), {
      maxRetries: 2,
      maxRetryDelayMs: 200,
      timeoutMs: 10_000,
    } as never, 4096).result();
    expect(thrice.stopReason).toBe("error");
    expect(requestCount).toBe(1 + 3);
  }, 20_000);

  it("completes a normal streamed reply through the local transport", async () => {
    behavior = { kind: "ok" };
    const model = localModel();
    const stream = reliableModelStream(localModels(), model, context(), {
      maxRetries: 0,
      timeoutMs: 10_000,
    } as never, 4096);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(localModelFetchMock).toHaveBeenCalled();
  }, 15_000);
});

describe("transport selection preservation", () => {
  it("keeps an explicit caller fetch for local models", async () => {
    const model = localModel();
    let customCalls = 0;
    const customFetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      customCalls += 1;
      return globalThis.fetch(input, init);
    }) as typeof globalThis.fetch;
    let captured: unknown;
    const fakeModels = {
      streamSimple: (_m: unknown, _c: unknown, opts: unknown) => {
        captured = opts;
        throw new Error("stop after capture");
      },
    };
    expect(() =>
      reliableModelStream(fakeModels as never, model, context(), { fetch: customFetch } as never, 4096),
    ).toThrow("stop after capture");
    expect(localModelFetchMock).not.toHaveBeenCalled();
    expect((captured as { fetch: unknown }).fetch).toBeDefined();
    const res = await ((captured as { fetch: typeof globalThis.fetch }).fetch)(
      `${baseUrl}/chat/completions`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(200);
    expect(customCalls).toBe(1);
  });

  it("never routes non-local providers through the local transport", async () => {
    const model = localModel();
    const nonLocal = { ...model, provider: "openai" } as Model<"openai-completions">;
    let captured: unknown;
    const fakeModels = {
      streamSimple: (_m: unknown, _c: unknown, opts: unknown) => {
        captured = opts;
        throw new Error("stop after capture");
      },
    };
    expect(() =>
      reliableModelStream(fakeModels as never, nonLocal, context(), {} as never, 4096),
    ).toThrow("stop after capture");
    expect(localModelFetchMock).not.toHaveBeenCalled();
    const res = await ((captured as { fetch: typeof globalThis.fetch }).fetch)(
      `${baseUrl}/chat/completions`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(200);
  });
});
