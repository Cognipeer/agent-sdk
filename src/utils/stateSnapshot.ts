import { AgentRuntimeConfig, AgentSnapshot, RestoreSnapshotOptions, SmartState, SnapshotOptions } from "../types.js";

const DISALLOWED_CTX_KEYS = new Set([
  "__onEvent",
  "__onProgress",
  "__onStream",
  "__traceSession",
  "__paused",
  "__cancellationToken",
  "__abortSignal",
]);

const clone = <T>(value: T): T => {
  if (typeof (globalThis as any).structuredClone === "function") {
    return (globalThis as any).structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const cleanCtx = (ctx?: Record<string, any>): Record<string, any> | undefined => {
  if (!ctx) return undefined;
  const entries = Object.entries(ctx).filter(([key]) => !DISALLOWED_CTX_KEYS.has(key));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
};

const runtimeHintFromAgent = (agent?: AgentRuntimeConfig) => {
  if (!agent) return undefined;
  const tools = Array.isArray(agent.tools) ? agent.tools.map((tool: any) => tool?.name).filter(Boolean) : undefined;
  return {
    name: agent.name,
    version: agent.version,
    tools: tools && tools.length > 0 ? tools : undefined,
  };
};

export function captureSnapshot(state: SmartState, options?: SnapshotOptions): AgentSnapshot {
  const { agent, ctx, ...rest } = state;
  const metadata = {
    createdAt: new Date().toISOString(),
    tag: options?.tag,
    paused: ctx?.__paused ?? null,
  };

  const safeState = clone({
    ...rest,
    ctx: cleanCtx(ctx),
  });

  if (safeState.ctx && "__paused" in safeState.ctx) {
    delete (safeState.ctx as Record<string, any>).__paused;
  }

  return {
    state: safeState,
    runtimeHint: options?.includeRuntimeHint !== false ? runtimeHintFromAgent(agent) : undefined,
    metadata,
  };
}

export function restoreSnapshot(snapshot: AgentSnapshot, restoreOptions?: RestoreSnapshotOptions): SmartState {
  const base = clone(snapshot.state) as SmartState;
  const incomingCtx = restoreOptions?.ctx;
  const mergedCtx = restoreOptions?.mergeCtx === false
    ? cleanCtx(incomingCtx)
    : {
        ...(base.ctx || {}),
        ...cleanCtx(incomingCtx),
      };

  const ctx = {
    ...(mergedCtx || {}),
    __restoredFromSnapshot: true,
  };

  const restored: SmartState = {
    ...base,
    ctx,
  };

  if (restoreOptions?.agent) {
    restored.agent = restoreOptions.agent;
  }

  return restored;
}
