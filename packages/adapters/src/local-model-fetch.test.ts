import type { RequestListener } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalModelTransport } from "./local-model-fetch.js";
import { dispatcherFetch } from "./undici-fetch.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function server(handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
function transport() {
  const t = createLocalModelTransport();
  cleanup.push(() => t.close());
  return t.fetch;
}
describe("local model HTTP transport", () => {
  it("reads delayed headers and delayed SSE body, then reuses the pool", async () => {
    const url = await server((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        setTimeout(() => res.end("data: done\n\n"), 100);
      }, 100);
    });
    const fetch = transport();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      expect(response).toBeInstanceOf(Response);
      expect(await response.text()).toBe("data: done\n\n");
    }
  });
  it("reproduces a lower-layer header cutoff while the local transport succeeds", async () => {
    const url = await server((_req, res) => setTimeout(() => res.end("ok"), 1200));
    const short = new Agent({ headersTimeout: 1 });
    cleanup.push(() => short.destroy());
    await expect(dispatcherFetch(url, { dispatcher: short } as RequestInit)).rejects.toThrow();
    expect(await (await transport()(url, { signal: AbortSignal.timeout(3000) })).text()).toBe("ok");
  });
  it("honors cancellation before headers", async () => {
    const url = await server(() => undefined);
    const fetch = transport();
    await expect(fetch(url, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });
  it("honors cancellation during a stalled body", async () => {
    const url = await server((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      res.write("data: first\n\n");
    });
    const response = await transport()(url, { signal: AbortSignal.timeout(100) });
    await expect(response.text()).rejects.toThrow();
  });
});
