import { Agent } from "undici";
import { modelConnectTimeoutMs } from "./pi-runtime-limits.js";
import { dispatcherFetch } from "./undici-fetch.js";

/** The SDK owns the response-header deadline and the runtime owns stream silence.
 * Disable undici's independent five-minute header/body clocks for the operator's
 * local model server. Its cold prefill can exceed that default before SSE starts.
 * Signals, including SDK deadlines and user cancellation, still abort the request.
 * A process-wide pool keeps connections reusable; no per-turn open Agent leaks.
 */
export function createLocalModelTransport(connectTimeoutMs = modelConnectTimeoutMs()) {
  const dispatcher = new Agent({
    connect: { timeout: connectTimeoutMs },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return {
    fetch: ((input, init) =>
      dispatcherFetch(input, {
        ...init,
        dispatcher,
      } as RequestInit & { dispatcher: Agent })) as typeof globalThis.fetch,
    close: () => dispatcher.destroy(),
  };
}

let transport: ReturnType<typeof createLocalModelTransport> | undefined;
export const localModelFetch: typeof globalThis.fetch = (input, init) => {
  transport ??= createLocalModelTransport();
  return transport.fetch(input, init);
};
