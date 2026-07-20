# ContextPilot

ContextPilot is a native, zero-dependency context/token optimization layer that runs at tool-execution time. It shrinks large tool outputs before they enter the transcript, while keeping every original payload recoverable later through `get_tool_response`. It never calls the model to do this — every decision is deterministic (BM25 relevance scoring, format sniffing, regex-based detection).

It is enabled by default. You don't need to opt in; you only need to override it if the defaults don't fit your workload.

## Quick example

```ts
const agent = createSmartAgent({
  model,
  tools,
  runtimeProfile: "balanced", // fast | balanced | deep | research | custom — top-level, not inside contextPilot
  contextPilot: {
    enabled: true,
    compression: {
      json: { enabled: true, targetRatio: 0.3 },
      text: { enabled: true, targetRatio: 0.5 },
      diff: { enabled: true, contextLines: 3 },
    },
    cacheAlignment: { enabled: true, warnOnVolatilePrompt: true },
    ccr: { enabled: true, ttlMs: 30 * 60 * 1000 },
    dedup: { enabled: true, minChars: 500 },
  },
});
```

`runtimeProfile` lives on the top-level `createSmartAgent` options, not inside `contextPilot` — it's a separate concern that happens to also scale a few ContextPilot defaults (see below).

## What actually lives under `contextPilot`

| Key | Fields | Notes |
|---|---|---|
| `enabled` | `boolean` | Master switch. `false` disables the whole layer. |
| `compression.json` | `enabled`, `targetRatio`, `minItems` | Compresses large arrays via BM25 relevance ranking. |
| `compression.text` | `enabled`, `targetRatio`, `minChars` | Extractive sentence compression for long plain text. |
| `compression.diff` | `enabled`, `contextLines` | Keeps unified-diff headers and `+`/`-` lines verbatim; trims unchanged context. |
| `compression.log` | `enabled`, `maxLines` | Always keeps the first/last line and ERROR/WARN-scored lines. |
| `compression.search` | `enabled`, `maxMatches` | Keeps grep/search matches with per-file diversity caps. |
| `ccr` | `enabled`, `ttlMs`, `maxEntries` | Reversible Compress-Cache-Retrieve store (see below). |
| `cacheAlignment` | `enabled`, `warnOnVolatilePrompt` | Detects volatile content (UUIDs, timestamps, JWTs, API keys) in the system prompt. |
| `dedup` | `enabled`, `minChars` | Cross-turn duplicate detection. |
| `excludeTools` | `string[]` | Tool names ContextPilot never touches. |

There is no `contextPilot.profile` field and no `relevance.scorer` field — relevance scoring is a fixed BM25-lite implementation and isn't pluggable today. `dedup` only has `enabled`/`minChars`; there's no `crossTurn`/`readLifecycle` split.

## How `targetRatio` works

For `compression.json`, `keepCount = max(1, min(arrayLength, ceil(arrayLength * targetRatio)))`. Items are ranked by BM25 relevance against the latest user message, the top `keepCount` survive in original order, and the rest are dropped. Nothing is lost — the full original array is stored in the CCR store and a marker with the CCR hash is appended to the compressed output.

`compression.text` uses the same idea at sentence granularity instead of array-item granularity.

## Runtime profiles scale ContextPilot too

`runtimeProfile` isn't just a tool-call/context-token preset — it also scales a few ContextPilot defaults so more aggressive profiles keep noticeably less, and looser profiles keep noticeably more:

| Profile | `json.targetRatio` | `text.targetRatio` | `ccr.ttlMs` | `ccr.maxEntries` |
|---|---:|---:|---:|---:|
| `fast` | 0.25 | 0.35 | 30 min (default) | 500 (default) |
| `balanced` | 0.35 | 0.5 | 30 min | 500 |
| `deep` | 0.5 | 0.6 | 60 min | 500 |
| `research` | 0.6 | 0.65 | 120 min | 1000 |

Any field you set explicitly under `contextPilot` in `createSmartAgent` overrides the profile default for that field.

## CCR: recovering a dropped payload

Every compression is reversible. Dropped items are stored in an in-memory `CCRStore` keyed by a short content hash, and the compressed output carries a note like:

```
"3 lower-relevance item(s) omitted by ContextPilot. Use get_tool_response with executionId=\"a1b2c3d4e5f6a7b8\" to retrieve the full original array if a dropped item is actually needed."
```

If the model later needs the full data, it calls the built-in `get_tool_response` tool with that `executionId`, and the agent returns the original, uncompressed value — as long as the entry hasn't expired (`ccr.ttlMs`) or been evicted (`ccr.maxEntries`, LRU).

## Cache alignment

If `cacheAlignment.enabled` is true, ContextPilot scans the system prompt for volatile substrings (UUIDs, ISO timestamps, Unix timestamps, JWTs, hex hashes, API keys). If any are found, it emits a single `metadata` event (`reason: "context_pilot_cache_alignment"`) once per run — it never rewrites the prompt, it only warns so you can move volatile values out of the cached prefix (useful for provider-side prompt caching).

## Cross-turn dedup

If the exact same tool output (byte-identical, after serialization) is produced again later in the same session, `dedup` replaces the repeat with a lightweight `DUPLICATE_TOOL_RESPONSE` pointer instead of re-sending the full payload, saving tokens without losing information — the original is still one `get_tool_response` call away.

## Excluding tools

Add a tool name to `contextPilot.excludeTools` to guarantee ContextPilot never compresses, dedups, or touches its output at all.
