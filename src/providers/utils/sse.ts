// SSE (Server-Sent Events) stream parser for fetch Response bodies.
// Works with OpenAI, Anthropic, Azure, Vertex and any text/event-stream endpoint.

export type SSEEvent = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

/**
 * Parses an SSE text/event-stream from a ReadableStream<Uint8Array>.
 * Yields individual SSEEvent objects for each complete event block.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split(/\r?\n\r?\n/);
      // Keep the last (potentially incomplete) part in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        const event = parseSSEBlock(part);
        if (event) yield event;
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      const event = parseSSEBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSEBlock(block: string): SSEEvent | null {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment

    const colonIdx = line.indexOf(":");
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1); // strip leading space
    }

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const n = parseInt(value, 10);
        if (!isNaN(n)) retry = n;
        break;
      }
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id, retry };
}
