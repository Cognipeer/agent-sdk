/**
 * A local HTTP server that behaves like a model endpoint that is still working,
 * so a test can observe — on the server's side of the socket — whether the
 * client hung up (`closedEarly`) or let the model finish (`finished`).
 *
 *   /...            an OpenAI chat-completions SSE stream of `chunks` text deltas
 *   /slow-json      a non-streaming answer that arrives after `slowJsonMs`
 *   /tool-stream    a stream that opens a tool call and keeps adding arguments
 *   /overloaded     503 on every request (retry/backoff tests)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type ServerHit = {
  path: string;
  /** Chunks written so far. */
  written: number;
  /** The client went away before the response was complete. */
  closedEarly: boolean;
  /** The response was written to the end. */
  finished: boolean;
};

export type SlowModelServerOptions = {
  chunks?: number;
  chunkGapMs?: number;
  slowJsonMs?: number;
};

export type SlowModelServer = {
  baseURL: string;
  hits: ServerHit[];
  reset(): void;
  close(): Promise<void>;
};

const sse = (data: unknown): string =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

export async function startSlowModelServer(options: SlowModelServerOptions = {}): Promise<SlowModelServer> {
  const chunks = options.chunks ?? 60;
  const gap = options.chunkGapMs ?? 25;
  const slowJsonMs = options.slowJsonMs ?? 2_500;
  const state: { hits: ServerHit[] } = { hits: [] };

  const server = http.createServer((req, res) => {
    const hit: ServerHit = { path: req.url ?? "", written: 0, closedEarly: false, finished: false };
    state.hits.push(hit);
    res.on("close", () => {
      if (!res.writableFinished) hit.closedEarly = true;
    });
    req.resume();
    req.on("end", () => {
      if (hit.path.includes("/overloaded")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("{}");
        hit.finished = true;
        return;
      }
      if (hit.path.includes("/slow-json")) {
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "x",
            model: "m",
            choices: [{ message: { role: "assistant", content: "late" }, finish_reason: "stop" }],
          }));
          hit.finished = true;
        }, slowJsonMs);
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const toolStream = hit.path.includes("/tool-stream");
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (i >= chunks) {
          res.write(sse({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: toolStream ? "tool_calls" : "stop" }] }));
          res.write(sse("[DONE]"));
          res.end();
          hit.finished = true;
          return;
        }
        if (toolStream) {
          const delta = i === 0
            ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"" } }] }
            : { tool_calls: [{ index: 0, function: { arguments: `w${i} ` } }] };
          res.write(sse({ id: "c", model: "m", choices: [{ index: 0, delta }] }));
        } else {
          res.write(sse({ id: "c", model: "m", choices: [{ index: 0, delta: { content: `w${i} ` } }] }));
        }
        i += 1;
        hit.written = i;
        setTimeout(tick, gap);
      };
      tick();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseURL,
    get hits() {
      return state.hits;
    },
    reset() {
      state.hits = [];
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Polls until the condition holds; throws when it does not within the timeout. */
export async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
