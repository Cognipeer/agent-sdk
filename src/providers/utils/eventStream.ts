// Decoder for the AWS event-stream binary framing (application/vnd.amazon.eventstream),
// used by Bedrock ConverseStream. Zero dependencies.
//
// Frame layout (big endian):
//   [0..4)   total length (whole frame, incl. prelude and trailing CRC)
//   [4..8)   headers length
//   [8..12)  prelude CRC32 (over bytes 0..8)
//   headers  (nameLen:u8, name, type:u8, value...)
//   payload
//   [-4..)   message CRC32 (over everything before it)

import { abortReason } from "../../utils/abort.js";

export type EventStreamHeaderValue = string | number | boolean | bigint | Uint8Array;

export type EventStreamMessage = {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
};

export class EventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStreamError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Parses one complete frame (already length-checked). Throws on CRC mismatch. */
export function decodeFrame(frame: Uint8Array): EventStreamMessage {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0);
  const headersLen = view.getUint32(4);
  if (total !== frame.byteLength) throw new EventStreamError("event-stream frame length mismatch");
  if (crc32(frame, 0, 8) !== view.getUint32(8)) throw new EventStreamError("event-stream prelude CRC mismatch");
  if (crc32(frame, 0, total - 4) !== view.getUint32(total - 4)) throw new EventStreamError("event-stream message CRC mismatch");
  if (12 + headersLen > total - 4) throw new EventStreamError("event-stream headers overflow frame");

  const headers: Record<string, EventStreamHeaderValue> = {};
  const td = new TextDecoder();
  let o = 12;
  const headersEnd = 12 + headersLen;
  while (o < headersEnd) {
    const nameLen = frame[o++];
    const name = td.decode(frame.subarray(o, o + nameLen));
    o += nameLen;
    const type = frame[o++];
    switch (type) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: headers[name] = view.getInt8(o); o += 1; break;
      case 3: headers[name] = view.getInt16(o); o += 2; break;
      case 4: headers[name] = view.getInt32(o); o += 4; break;
      case 5: headers[name] = view.getBigInt64(o); o += 8; break;
      case 6: {
        const len = view.getUint16(o); o += 2;
        headers[name] = frame.slice(o, o + len); o += len; break;
      }
      case 7: {
        const len = view.getUint16(o); o += 2;
        headers[name] = td.decode(frame.subarray(o, o + len)); o += len; break;
      }
      case 8: headers[name] = view.getBigInt64(o); o += 8; break;
      case 9: headers[name] = frame.slice(o, o + 16); o += 16; break;
      default: throw new EventStreamError(`unknown event-stream header type ${type}`);
    }
  }
  return { headers, payload: frame.slice(headersEnd, total - 4) };
}

/** Reads a byte stream and yields decoded event-stream messages. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<EventStreamMessage, void, unknown> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;

      while (buf.length >= 12) {
        const total = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
        if (total < 16) throw new EventStreamError("invalid event-stream frame length");
        if (buf.length < total) break;
        yield decodeFrame(buf.subarray(0, total));
        buf = buf.subarray(total);
      }
    }
    if (buf.length > 0) throw new EventStreamError("event-stream ended inside a frame");
  } finally {
    reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* pending read */ }
  }
}

/** Encodes a frame (used by tests and fixtures). */
export function encodeFrame(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const te = new TextEncoder();
  const pl = typeof payload === "string" ? te.encode(payload) : payload;
  const hdrParts: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = te.encode(k);
    const vb = te.encode(v);
    hdrParts.push(kb.length, ...kb, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);
  }
  const total = 12 + hdrParts.length + pl.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, hdrParts.length);
  view.setUint32(8, crc32(out, 0, 8));
  out.set(hdrParts, 12);
  out.set(pl, 12 + hdrParts.length);
  view.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}
