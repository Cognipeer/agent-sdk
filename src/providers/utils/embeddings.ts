// Shared helpers for the providers' embed() implementations.

import { ProviderError } from "../types.js";

/** Splits `items` into consecutive groups of at most `size` (size < 1 → 1). */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        failure = err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  if (failed) throw failure;
  return results;
}

/** Decodes an OpenAI `encoding_format: "base64"` vector (little-endian float32). */
export function decodeBase64Vector(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: number[] = new Array(Math.floor(buf.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Throws a clear error when the provider returned fewer/more vectors than inputs. */
export function assertVectorCount(provider: string, vectors: unknown[], expected: number): void {
  if (vectors.length !== expected) {
    throw new ProviderError(
      `${provider} embeddings returned ${vectors.length} vectors for ${expected} inputs`,
      provider,
      502,
    );
  }
}

export function requireEmbeddingModel(provider: string, model: string | undefined): string {
  if (!model) throw new ProviderError(`${provider} embeddings require a model`, provider, 400);
  return model;
}
