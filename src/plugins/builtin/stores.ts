/**
 * Slot implementations for the two stores every product ends up writing itself:
 * conversation history and checkpoint persistence.
 *
 * The in-memory versions are real implementations, not stubs — they are the
 * right choice for tests, for single-process workers, and for a first
 * deployment. The file-backed checkpoint store is the smallest thing that
 * survives a restart.
 */

import type { AgentPlugin, CheckpointStore, ConversationStore, MaybePromise } from "../types.js";
import type { AgentSnapshot, Message, SmartState } from "../../types.js";
import { captureSnapshot } from "../../utils/stateSnapshot.js";

// ─── Conversation store ──────────────────────────────────────────────────────

export type ConversationPluginConfig = {
  store: ConversationStore;
  /**
   * Which thread this run belongs to. A string is a fixed thread; a function
   * reads it from the incoming state (typically `state.metadata.threadId`).
   */
  threadId: string | ((state: unknown) => string | undefined);
  /** Cap the messages loaded back. Default: everything the store returns. */
  maxMessages?: number;
  name?: string;
  priority?: number;
};

/**
 * Hydrates the transcript on `sessionStart` and appends the new turns on
 * `sessionEnd`. Only messages produced by this run are appended, so replaying
 * the same thread does not duplicate history.
 */
export function conversationHistory(config: ConversationPluginConfig): AgentPlugin {
  const resolveThreadId = (state: unknown): string | undefined =>
    typeof config.threadId === "function" ? config.threadId(state) : config.threadId;

  return {
    name: config.name ?? "conversation-history",
    priority: config.priority ?? 1,
    failureMode: "open",
    provides: { conversationStore: config.store },

    hooks: {
      sessionStart: async ({ messages, resumed }, ctx) => {
        const threadId = resolveThreadId(ctx.state);
        if (!threadId) return undefined;
        ctx.store.__threadId = threadId;

        // A resumed run already carries its transcript in the snapshot;
        // reloading would duplicate every turn. The baseline still has to be
        // recorded, or `sessionEnd` would append that carried transcript again.
        if (resumed) {
          ctx.store.__baseline = messages.length;
          return undefined;
        }

        const history = await config.store.load(threadId);
        if (!history || history.length === 0) {
          // The baseline counts what came out of the store, never the incoming
          // turn — that turn is exactly what has to be persisted.
          ctx.store.__baseline = 0;
          return undefined;
        }

        const trimmed = config.maxMessages ? history.slice(-config.maxMessages) : history;
        ctx.store.__baseline = trimmed.length;
        return { messages: [...trimmed, ...messages] };
      },

      sessionEnd: async (_input, ctx) => {
        const threadId = (ctx.store.__threadId as string | undefined) ?? resolveThreadId(ctx.state);
        if (!threadId) return;
        const messages = ((ctx.state as { messages?: Message[] }).messages ?? []) as Message[];
        const baseline = (ctx.store.__baseline as number | undefined) ?? 0;
        const fresh = messages.slice(baseline);
        if (fresh.length > 0) await config.store.append(threadId, fresh);
      },
    },
  };
}

export function inMemoryConversationStore(): ConversationStore {
  const threads = new Map<string, Message[]>();
  return {
    load: (threadId) => threads.get(threadId) ?? [],
    append: (threadId, messages) => {
      threads.set(threadId, [...(threads.get(threadId) ?? []), ...messages]);
    },
    clear: (threadId) => {
      threads.delete(threadId);
    },
  };
}

// ─── Checkpoint store ────────────────────────────────────────────────────────

export type CheckpointPluginConfig = {
  store: CheckpointStore;
  /** Checkpoint id. Defaults to the run id. */
  id?: string | ((state: unknown) => string | undefined);
  /**
   * Which pauses to persist. Default: every non-success ending, which is when a
   * run can actually be continued.
   */
  saveOn?: Array<"paused" | "cancelled" | "error" | "success">;
  /** Build the snapshot. Defaults to `captureSnapshot` semantics via the host. */
  capture?: (state: unknown) => MaybePromise<AgentSnapshot>;
  name?: string;
  priority?: number;
};

/**
 * Persists a snapshot whenever a run ends in a resumable state. The SDK already
 * has `snapshot()` / `resume()`; what it has never had is somewhere to put the
 * result.
 */
export function checkpointing(config: CheckpointPluginConfig): AgentPlugin {
  const saveOn = new Set(config.saveOn ?? ["paused", "cancelled", "error"]);

  return {
    name: config.name ?? "checkpointing",
    priority: config.priority ?? 900,
    failureMode: "open",
    provides: { checkpointStore: config.store },

    hooks: {
      sessionEnd: async ({ status }, ctx) => {
        if (!saveOn.has(status)) return;
        const id =
          (typeof config.id === "function" ? config.id(ctx.state) : config.id) ?? ctx.runId;
        if (!id) return;
        // `captureSnapshot` strips the ctx keys that must not be persisted:
        // `__pluginState` is a cycle back to the state (which would throw on
        // serialization, inside a swallowed observer) and `__traceSession`
        // carries the tracing api key in cleartext.
        const snapshot = config.capture
          ? await config.capture(ctx.state)
          : captureSnapshot(ctx.state as SmartState);
        await config.store.save(id, snapshot);
        ctx.emit({ type: "metadata", checkpoint: { id, status } } as never);
      },
    },
  };
}

export function inMemoryCheckpointStore(): CheckpointStore {
  const snapshots = new Map<string, AgentSnapshot>();
  return {
    save: (id, snapshot) => {
      snapshots.set(id, snapshot);
    },
    load: (id) => snapshots.get(id) ?? null,
    list: (prefix) =>
      [...snapshots.keys()].filter((key) => (prefix ? key.startsWith(prefix) : true)),
    remove: (id) => {
      snapshots.delete(id);
    },
  };
}

/**
 * File-backed checkpoints. One JSON file per id under `dir`. Node only — the
 * `fs` import is dynamic so bundling for an edge runtime does not pull it in
 * unless this function is actually called.
 */
export function fileCheckpointStore(dir = ".checkpoints"): CheckpointStore {
  const safeName = (id: string) => `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

  return {
    async save(id, snapshot) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, safeName(id)), JSON.stringify(snapshot, null, 2), "utf8");
    },
    async load(id) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      try {
        const raw = await fs.readFile(path.join(dir, safeName(id)), "utf8");
        return JSON.parse(raw) as AgentSnapshot;
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const fs = await import("node:fs/promises");
      try {
        const files = await fs.readdir(dir);
        return files
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.slice(0, -5))
          .filter((id) => (prefix ? id.startsWith(prefix) : true));
      } catch {
        return [];
      }
    },
    async remove(id) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      try {
        await fs.unlink(path.join(dir, safeName(id)));
      } catch {
        /* already gone */
      }
    },
  };
}
