// Zero-dependency BM25-lite relevance scorer used across ContextPilot
// compressors to rank tool-output items/sentences against the active user
// query, so the most relevant content survives compression.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "in", "on", "at", "to", "by", "with",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those", "it", "its", "as", "from",
]);

/** Unicode-aware tokenizer: splits on non-word boundaries so it works for Turkish, CJK, etc. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export type Bm25Params = { k1?: number; b?: number };

/**
 * Scores each document in `docs` against `query` using BM25. When `query` is
 * empty, every document gets a neutral score of 1 (callers should then rely
 * on their own tie-break, e.g. recency or original order).
 */
export function scoreItemsByRelevance(docs: string[], query: string, params: Bm25Params = {}): number[] {
  const k1 = params.k1 ?? 1.5;
  const b = params.b ?? 0.75;
  const queryTokens = tokenize(query);
  const docTokens = docs.map((doc) => tokenize(doc));

  if (queryTokens.length === 0) {
    return docs.map(() => 1);
  }

  const docLengths = docTokens.map((tokens) => tokens.length);
  const avgDocLen = docLengths.reduce((sum, len) => sum + len, 0) / Math.max(1, docLengths.length);

  const uniqueQueryTerms = [...new Set(queryTokens)];
  const df = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    let count = 0;
    for (const tokens of docTokens) {
      if (tokens.includes(term)) count += 1;
    }
    df.set(term, count);
  }

  const n = docs.length;
  const idf = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    const freq = df.get(term) || 0;
    idf.set(term, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
  }

  return docTokens.map((tokens, docIndex) => {
    if (tokens.length === 0) return 0;
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
    const docLen = docLengths[docIndex];
    let score = 0;
    for (const term of uniqueQueryTerms) {
      const freq = termFreq.get(term) || 0;
      if (freq === 0) continue;
      const termIdf = idf.get(term) || 0;
      const numerator = freq * (k1 + 1);
      const denominator = freq + k1 * (1 - b + (b * docLen) / avgDocLen);
      score += termIdf * (numerator / denominator);
    }
    return score;
  });
}

/** Ranks items by score (desc), keeps the top `count`, then restores original order. */
export function selectTopIndicesInOrder(scores: number[], count: number): number[] {
  const ranked = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, count))
    .map((entry) => entry.index);
  return ranked.sort((a, b) => a - b);
}
