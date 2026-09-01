/**
 * Plugin layer — runtime.
 *
 * `createPluginHost` is agent-scoped: it validates the plugin set, resolves
 * slots and contributions once, and owns setup/dispose. `beginRun` opens a
 * run-scoped handle whose per-plugin stores live and die with one `invoke()`,
 * which is what keeps concurrent invokes on the same agent instance isolated.
 *
 * Composition rules (see docs/guide/plugins.md):
 *   R1 order        priority ascending, then registration order; stable
 *   R2 mutation     chained — each handler sees the previous one's output
 *   R3 decision     deny > ask > allow; the first deny short-circuits the chain
 *   R4 short-circuit first value offered wins, the rest are reported and dropped
 *   R5 errors       per-plugin failureMode: "open" continues, "closed" denies
 *   R6 timeout      per-handler, treated as an error under R5
 *   R7 observers    never block and never fail the run
 *   R8 observable   every decision/mutation is emitted as a `plugin` event
 */

import type {
  AgentPlugin,
  GateResult,
  HookContext,
  HookDecision,
  HookMap,
  HookName,
  HookRegistrations,
  PluginContributions,
  PluginFailureMode,
  PluginHostOptions,
  PluginLogger,
  PluginProvides,
  PluginSetupContext,
  PluginTraceRecord,
  SlotName,
} from "./types.js";
import type { ConversationGuardrail, SmartAgentEvent, SmartState, ToolInterface } from "../types.js";
import { collectAttachments, replaceTextContent, textFromContent } from "../utils/content.js";

const DEFAULT_PRIORITY = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Composition descriptor per hook — how a handler's output folds into the chain. */
type HookSpec = {
  kind: "gate" | "observer";
  /** Replace-semantics payload fields. */
  mutable?: string[];
  /** Shallow-merge payload fields (never wholesale replacement). */
  merge?: string[];
  /** Accumulated across handlers rather than replacing. */
  collect?: string[];
  /** First handler to supply a value wins; later ones are dropped. */
  firstWins?: string[];
  /** OR-ed across handlers. */
  flags?: string[];
  /**
   * Re-derive dependent fields after a handler's patch, so the next handler in
   * the chain sees a coherent payload rather than a half-updated one.
   */
  normalize?: (
    input: Record<string, unknown>,
    previous: Record<string, unknown>,
  ) => Record<string, unknown>;
};

const HOOK_SPECS: Record<HookName, HookSpec> = {
  sessionStart: { kind: "gate", mutable: ["messages"], collect: ["systemPromptAppend"] },
  userPromptSubmit: {
    kind: "gate",
    mutable: ["text", "content"],
    collect: ["additionalContext"],
    // `text`, `content` and `attachments` are three views of one value. A
    // handler may write either of the first two; this puts the other two back
    // in agreement before the next handler in the chain runs.
    normalize: (input, previous) => {
      if (input.content !== previous.content) {
        return {
          ...input,
          text: textFromContent(input.content),
          attachments: collectAttachments(input.content),
        };
      }
      if (input.text !== previous.text) {
        const content = replaceTextContent(previous.content, input.text as string);
        return { ...input, content, attachments: collectAttachments(content) };
      }
      return input;
    },
  },
  preModelCall: { kind: "gate", mutable: ["messages", "tools"], merge: ["params"], firstWins: ["shortCircuit"] },
  postModelCall: { kind: "gate", mutable: ["message"], flags: ["retry"] },
  preToolUse: { kind: "gate", mutable: ["args"], firstWins: ["result", "approvalPrompt"] },
  postToolUse: { kind: "gate", mutable: ["output"] },
  preCompact: { kind: "gate", mutable: ["messages"], flags: ["skip"] },
  postCompact: { kind: "observer" },
  preFinalAnswer: { kind: "gate", mutable: ["content"], firstWins: ["continueWith"] },
  subagentStart: { kind: "gate", mutable: ["task"] },
  subagentStop: { kind: "observer" },
  notification: { kind: "observer" },
  sessionEnd: { kind: "observer" },
};

export const HOOK_NAMES = Object.keys(HOOK_SPECS) as HookName[];

const SLOT_NAMES: SlotName[] = [
  "summarizer",
  "tokenCounter",
  "costEstimator",
  "memoryStore",
  "conversationStore",
  "checkpointStore",
  "approvalTransport",
  "skillSource",
  "promptSource",
  "contextBuilder",
];

const DECISION_RANK: Record<HookDecision, number> = { allow: 0, ask: 1, deny: 2 };

function escalate(current: HookDecision, next: HookDecision): HookDecision {
  return DECISION_RANK[next] > DECISION_RANK[current] ? next : current;
}

export class HookTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "HookTimeoutError";
  }
}

function withTimeout<T>(value: T | Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookTimeoutError(label, ms)), ms);
    Promise.resolve(value).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const noopLogger: PluginLogger = {
  debug: () => {},
  warn: (...args: unknown[]) => console.warn("[agent-sdk:plugins]", ...args),
  error: (...args: unknown[]) => console.error("[agent-sdk:plugins]", ...args),
};

type RegisteredHandler = {
  plugin: string;
  priority: number;
  failureMode: PluginFailureMode;
  timeoutMs: number;
  order: number;
  handler: (input: unknown, ctx: HookContext) => unknown;
};

export type PluginRunHost = {
  /** Cheap guard so call sites can skip building payloads when nothing listens. */
  has(hook: HookName): boolean;
  /** Cap on `postModelCall.retry` for this run. */
  readonly maxModelRetries: number;
  /** Cap on `preFinalAnswer.continueWith` for this run. */
  readonly maxContinuations: number;
  /**
   * True when some registered `preToolUse` plugin may return `ask`. Call sites
   * use it to keep such calls out of the parallel fan-out.
   */
  readonly mayPauseOnToolUse: boolean;
  runGate<K extends HookName>(hook: K, input: HookMap[K]["input"]): Promise<GateResult<K>>;
  runObservers<K extends HookName>(hook: K, input: HookMap[K]["input"]): Promise<void>;
  /** Release per-run plugin stores. */
  end(): void;
};

export type PluginHost = {
  readonly plugins: AgentPlugin[];
  readonly slots: PluginProvides;
  readonly contributions: PluginContributions;
  readonly maxModelRetries: number;
  readonly maxContinuations: number;
  has(hook: HookName): boolean;
  hasAny(): boolean;
  /** True when some `preToolUse` plugin may escalate a call to human approval. */
  mayPauseOnToolUse(): boolean;
  /** Resolve contributions and run every `setup`. Idempotent; a failure sticks. */
  setup(ctx: Omit<PluginSetupContext, "onDispose" | "logger"> & { logger?: PluginLogger }): Promise<void>;
  dispose(): Promise<void>;
  beginRun(opts: {
    runId: string;
    agentName?: string;
    getState: () => SmartState;
    emit?: (event: SmartAgentEvent) => void;
    /** Put a material hook outcome on the trace timeline. */
    recordTrace?: (record: PluginTraceRecord) => void;
    signal?: AbortSignal;
    depth?: number;
  }): PluginRunHost;
  /** The subset a child agent inherits. */
  childPlugins(): AgentPlugin[];
};

/** Flatten `hooks` into a registration list, tolerating single-fn and array forms. */
function collectRegistrations(
  plugin: AgentPlugin,
  registrations: HookRegistrations | undefined,
  into: Map<HookName, RegisteredHandler[]>,
  orderRef: { value: number },
): void {
  if (!registrations) return;
  for (const hook of HOOK_NAMES) {
    const entry = (registrations as Record<string, unknown>)[hook];
    if (!entry) continue;
    const handlers = Array.isArray(entry) ? entry : [entry];
    for (const handler of handlers) {
      if (typeof handler !== "function") continue;
      const list = into.get(hook) ?? [];
      list.push({
        plugin: plugin.name,
        priority: plugin.priority ?? DEFAULT_PRIORITY,
        failureMode: plugin.failureMode ?? "open",
        timeoutMs: plugin.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        order: orderRef.value++,
        handler: handler as RegisteredHandler["handler"],
      });
      into.set(hook, list);
    }
  }
}

export function createPluginHost(
  plugins: AgentPlugin[] = [],
  options: PluginHostOptions = {},
): PluginHost {
  const logger = options.logger ?? noopLogger;
  const active = plugins.filter(Boolean);

  // R-validation: a duplicate name makes "which plugin denied this" unanswerable.
  const seen = new Set<string>();
  for (const plugin of active) {
    if (!plugin.name || typeof plugin.name !== "string") {
      throw new Error("[agent-sdk] Every plugin needs a unique `name`.");
    }
    if (seen.has(plugin.name)) {
      throw new Error(`[agent-sdk] Duplicate plugin name "${plugin.name}". Plugin names must be unique per agent.`);
    }
    seen.add(plugin.name);
  }

  // Stable ordering: priority ascending, then declaration order.
  const ordered = active
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) =>
      (a.plugin.priority ?? DEFAULT_PRIORITY) - (b.plugin.priority ?? DEFAULT_PRIORITY) || a.index - b.index,
    )
    .map((entry) => entry.plugin);

  const registry = new Map<HookName, RegisteredHandler[]>();
  const orderRef = { value: 0 };
  for (const plugin of ordered) {
    collectRegistrations(plugin, plugin.hooks, registry, orderRef);
  }
  for (const [hook, list] of registry) {
    list.sort((a, b) => a.priority - b.priority || a.order - b.order);
    registry.set(hook, list);
  }

  // Slots: exactly one owner. Two claimants is a construction error, never a
  // silent last-one-wins — a summarizer that quietly lost is undebuggable.
  const slots: PluginProvides = {};
  const slotOwners = new Map<SlotName, string>();
  for (const plugin of ordered) {
    const provides = plugin.provides;
    if (!provides) continue;
    for (const slot of SLOT_NAMES) {
      const value = provides[slot];
      if (value === undefined || value === null) continue;
      const existing = slotOwners.get(slot);
      if (existing) {
        throw new Error(
          `[agent-sdk] Slot "${slot}" is claimed by both "${existing}" and "${plugin.name}". ` +
            `A slot replaces an SDK default and can have exactly one owner — remove one plugin or disable its slot.`,
        );
      }
      slotOwners.set(slot, plugin.name);
      (slots as Record<string, unknown>)[slot] = value;
    }
  }

  const disposers: Array<() => unknown> = [];
  let contributions: PluginContributions = {
    tools: [],
    toolDescriptions: {},
    guardrails: [],
    applySystemPrompt: (base: string) => base,
    applyModelWrappers: (model: unknown) => model,
  };
  // Memoised rather than a boolean: callers run setup() on every invoke, so a
  // setup that rejected must keep rejecting instead of silently handing back
  // empty contributions — that would run later invokes without the fail-closed
  // plugin that refused to start.
  let setupPromise: Promise<void> | undefined;

  async function runSetup(setupInput: Parameters<PluginHost["setup"]>[0]): Promise<void> {
    const tools: ToolInterface[] = [];
    const toolDescriptions: Record<string, string | ((d: string) => string)> = {};
    const guardrails: ConversationGuardrail[] = [];
    const promptSteps: Array<(current: string, ctx: PluginSetupContext) => string> = [];
    const modelWrappers: Array<{ plugin: string; wrap: (model: unknown, ctx: PluginSetupContext) => unknown }> = [];

    for (const plugin of ordered) {
      const pluginCtx: PluginSetupContext = {
        agentName: setupInput.agentName,
        agentVersion: setupInput.agentVersion,
        model: setupInput.model,
        logger: setupInput.logger ?? logger,
        onDispose: (fn) => disposers.push(fn),
      };

      if (typeof plugin.setup === "function") {
        try {
          const maybeDisposer = await plugin.setup(pluginCtx);
          if (typeof maybeDisposer === "function") disposers.push(maybeDisposer);
        } catch (err) {
          // A plugin that cannot start is a hard failure when it declared
          // itself fail-closed: silently running without a security control
          // is worse than not starting at all.
          if ((plugin.failureMode ?? "open") === "closed") {
            throw new Error(
              `[agent-sdk] Plugin "${plugin.name}" failed to set up and is fail-closed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          logger.warn(`plugin "${plugin.name}" setup failed (fail-open, continuing):`, err);
          continue;
        }
      }

      if (typeof plugin.dispose === "function") disposers.push(() => plugin.dispose!());

      if (plugin.tools) {
        const resolved = typeof plugin.tools === "function" ? await plugin.tools(pluginCtx) : plugin.tools;
        if (Array.isArray(resolved)) tools.push(...resolved.filter(Boolean));
      }
      if (plugin.systemPrompt) {
        const contribution = plugin.systemPrompt;
        promptSteps.push((current, ctx) =>
          typeof contribution === "function"
            ? contribution(current, ctx)
            : [current, contribution].filter(Boolean).join("\n\n"),
        );
      }
      if (plugin.toolDescriptions) Object.assign(toolDescriptions, plugin.toolDescriptions);
      if (plugin.guardrails?.length) guardrails.push(...plugin.guardrails);
      if (typeof plugin.wrapModel === "function") {
        modelWrappers.push({ plugin: plugin.name, wrap: plugin.wrapModel });
      }
    }

    const sharedCtx: PluginSetupContext = {
      agentName: setupInput.agentName,
      agentVersion: setupInput.agentVersion,
      model: setupInput.model,
      logger: setupInput.logger ?? logger,
      onDispose: (fn) => disposers.push(fn),
    };

    contributions = {
      tools,
      toolDescriptions,
      guardrails,
      applySystemPrompt: (base: string) =>
        promptSteps.reduce((current, step) => {
          try {
            return step(current, sharedCtx) ?? current;
          } catch (err) {
            logger.warn("systemPrompt contribution failed:", err);
            return current;
          }
        }, base),
      // Ascending priority: the first (highest-priority) wrapper sits closest
      // to the raw model, later ones wrap around it.
      applyModelWrappers: (model: unknown) =>
        modelWrappers.reduce((current, entry) => {
          try {
            return entry.wrap(current, { ...sharedCtx, model: current }) ?? current;
          } catch (err) {
            logger.warn(`wrapModel from "${entry.plugin}" failed, using unwrapped model:`, err);
            return current;
          }
        }, model),
    };
  }

  const host: PluginHost = {
    plugins: ordered,
    slots,
    get contributions() {
      return contributions;
    },
    maxModelRetries: options.maxModelRetries ?? 2,
    maxContinuations: options.maxContinuations ?? 2,

    has(hook) {
      const list = registry.get(hook);
      return !!list && list.length > 0;
    },

    hasAny() {
      return registry.size > 0;
    },

    mayPauseOnToolUse() {
      const handlers = registry.get("preToolUse") ?? [];
      if (handlers.length === 0) return false;
      const pausing = new Set(
        ordered.filter((plugin) => plugin.mayRequireApproval !== false).map((plugin) => plugin.name),
      );
      return handlers.some((entry) => pausing.has(entry.plugin));
    },

    setup(setupInput) {
      setupPromise ??= runSetup(setupInput);
      return setupPromise;
    },

    async dispose() {
      const pending = disposers.splice(0, disposers.length).reverse();
      await Promise.allSettled(
        pending.map(async (fn) => {
          try {
            await fn();
          } catch (err) {
            logger.warn("plugin dispose failed:", err);
          }
        }),
      );
    },

    childPlugins() {
      return ordered.filter((plugin) => plugin.inheritToSubagents !== false);
    },

    beginRun(runOpts) {
      const stores = new Map<string, Record<string, unknown>>();
      const emit = runOpts.emit ?? (() => {});
      const depth = runOpts.depth ?? 0;

      const storeFor = (plugin: string) => {
        let store = stores.get(plugin);
        if (!store) {
          store = {};
          stores.set(plugin, store);
        }
        return store;
      };

      const contextFor = (entry: RegisteredHandler, hook: HookName): HookContext => ({
        runId: runOpts.runId,
        agentName: runOpts.agentName,
        hookName: hook,
        // Read per call: the trace session appears part-way through a smart run.
        traceId: (runOpts.getState() as { ctx?: { __traceSession?: { traceId?: string } } })?.ctx
          ?.__traceSession?.traceId,
        state: runOpts.getState(),
        store: storeFor(entry.plugin),
        emit,
        logger: {
          debug: (...args) => logger.debug(`[${entry.plugin}]`, ...args),
          warn: (...args) => logger.warn(`[${entry.plugin}]`, ...args),
          error: (...args) => logger.error(`[${entry.plugin}]`, ...args),
        },
        signal: runOpts.signal,
        depth,
      });

      /**
       * The trace gets material outcomes only. Recording one event per handler
       * per hook would multiply outbound streaming POSTs 1:1 with hook calls
       * and renumber every subsequent event's sequence and label.
       */
      const recordTrace = (
        entry: RegisteredHandler,
        hook: HookName,
        record: Omit<PluginTraceRecord, "plugin" | "hook">,
      ) => {
        if (!runOpts.recordTrace) return;
        const material =
          options.debug
          || record.status !== "success"
          || (record.decision && record.decision !== "allow")
          || record.mutated
          || record.shortCircuited;
        if (!material) return;
        try {
          runOpts.recordTrace({ plugin: entry.plugin, hook, ...record });
        } catch {
          // Observability must never disturb the run.
        }
      };

      const emitPluginEvent = (
        entry: RegisteredHandler,
        hook: HookName,
        payload: {
          phase: "success" | "error" | "timeout";
          decision?: HookDecision;
          mutated?: boolean;
          shortCircuited?: boolean;
          reason?: string;
          durationMs?: number;
          error?: { message: string };
        },
      ) => {
        const interesting =
          options.debug ||
          payload.phase !== "success" ||
          (payload.decision && payload.decision !== "allow") ||
          payload.mutated ||
          payload.shortCircuited;
        if (!interesting) return;
        try {
          emit({ type: "plugin", plugin: entry.plugin, hook, ...payload } as unknown as SmartAgentEvent);
        } catch {
          // An observability failure must never disturb the run.
        }
      };

      return {
        has: (hook) => host.has(hook),
        maxModelRetries: host.maxModelRetries,
        maxContinuations: host.maxContinuations,
        mayPauseOnToolUse: host.mayPauseOnToolUse(),

        async runGate<K extends HookName>(hook: K, input: HookMap[K]["input"]): Promise<GateResult<K>> {
          const spec = HOOK_SPECS[hook];
          const handlers = registry.get(hook) ?? [];
          const result: GateResult<K> = {
            decision: "allow",
            input,
            mutated: false,
            mutatedBy: [],
            collected: {},
            flags: {},
          };
          if (handlers.length === 0) return result;

          let current: Record<string, unknown> = input as Record<string, unknown>;

          for (const entry of handlers) {
            const startedAt = performanceNow();
            let output: Record<string, unknown> | undefined;

            try {
              const raw = await withTimeout(
                entry.handler(current, contextFor(entry, hook)),
                entry.timeoutMs,
                `plugin "${entry.plugin}" hook "${hook}"`,
              );
              output = (raw ?? undefined) as Record<string, unknown> | undefined;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const timedOut = err instanceof HookTimeoutError;
              logger.warn(`plugin "${entry.plugin}" hook "${hook}" failed:`, message);
              emitPluginEvent(entry, hook, {
                phase: timedOut ? "timeout" : "error",
                error: { message },
                durationMs: performanceNow() - startedAt,
              });
              recordTrace(entry, hook, {
                status: entry.failureMode === "closed" ? "error" : "skipped",
                error: { message },
                durationMs: performanceNow() - startedAt,
              });
              if (entry.failureMode === "closed") {
                result.decision = "deny";
                result.reason = `${entry.plugin}: ${timedOut ? "timed out" : "hook error"} (fail-closed) — ${message}`;
                result.deniedBy = entry.plugin;
                result.input = current as HookMap[K]["input"];
                return result;
              }
              continue;
            }

            if (!output || typeof output !== "object") {
              emitPluginEvent(entry, hook, { phase: "success", durationMs: performanceNow() - startedAt });
              continue;
            }

            let mutatedHere = false;
            let shortCircuitedHere = false;
            const previousInput = current;

            for (const field of spec.mutable ?? []) {
              if (output[field] !== undefined) {
                current = { ...current, [field]: output[field] };
                mutatedHere = true;
              }
            }
            for (const field of spec.merge ?? []) {
              if (output[field] && typeof output[field] === "object") {
                current = {
                  ...current,
                  [field]: { ...(current[field] as object), ...(output[field] as object) },
                };
                mutatedHere = true;
              }
            }
            for (const field of spec.collect ?? []) {
              if (output[field] !== undefined) {
                (result.collected[field] ??= []).push(output[field]);
              }
            }
            for (const field of spec.flags ?? []) {
              if (output[field] === true) result.flags[field] = true;
            }
            for (const field of spec.firstWins ?? []) {
              if (output[field] === undefined) continue;
              if (field === "shortCircuit" || field === "result") {
                if (result.shortCircuit === undefined) {
                  result.shortCircuit = output[field];
                  shortCircuitedHere = true;
                } else {
                  logger.warn(
                    `plugin "${entry.plugin}" offered a second short-circuit for "${hook}"; the first one wins.`,
                  );
                }
              } else if ((result as Record<string, unknown>)[field] === undefined) {
                (result as Record<string, unknown>)[field] = output[field];
              }
            }

            if (mutatedHere && spec.normalize) {
              current = spec.normalize(current, previousInput) as Record<string, unknown>;
            }

            if (output.metadata && typeof output.metadata === "object") {
              result.metadata = { ...(result.metadata ?? {}), ...(output.metadata as object) };
            }

            const decision = output.decision as HookDecision | undefined;
            const escalated = decision ? escalate(result.decision, decision) : result.decision;
            // The handler that raised the bar owns the explanation: otherwise a
            // deny would be surfaced with an earlier, non-blocking reason.
            const escalatesHere = escalated !== result.decision;
            result.decision = escalated;
            if (typeof output.reason === "string" && (escalatesHere || !result.reason)) {
              result.reason = `${entry.plugin}: ${output.reason}`;
            }
            if (mutatedHere) {
              result.mutated = true;
              result.mutatedBy.push(entry.plugin);
            }

            const outcomeDuration = performanceNow() - startedAt;
            emitPluginEvent(entry, hook, {
              phase: "success",
              decision,
              mutated: mutatedHere,
              shortCircuited: shortCircuitedHere,
              reason: typeof output.reason === "string" ? output.reason : undefined,
              durationMs: outcomeDuration,
            });
            recordTrace(entry, hook, {
              // A policy decision is not a system error, so a deny is recorded
              // as "skipped": the step did not proceed, the run is healthy.
              status: decision && decision !== "allow" ? "skipped" : "success",
              decision,
              mutated: mutatedHere,
              // The chain so far, so an audit can answer "who touched this
              // before me" as well as "did I touch it".
              mutatedBy: result.mutatedBy.length > 0 ? [...result.mutatedBy] : undefined,
              shortCircuited: shortCircuitedHere,
              reason: typeof output.reason === "string" ? output.reason : undefined,
              durationMs: outcomeDuration,
            });

            // R3: a deny is terminal for this chain.
            if (result.decision === "deny") {
              result.deniedBy = entry.plugin;
              break;
            }
          }

          result.input = current as HookMap[K]["input"];
          return result;
        },

        async runObservers<K extends HookName>(hook: K, input: HookMap[K]["input"]): Promise<void> {
          const handlers = registry.get(hook) ?? [];
          if (handlers.length === 0) return;
          // R7: observers run concurrently, cannot mutate, and cannot fail the run.
          await Promise.allSettled(
            handlers.map(async (entry) => {
              const startedAt = performanceNow();
              try {
                await withTimeout(
                  entry.handler(input, contextFor(entry, hook)),
                  entry.timeoutMs,
                  `plugin "${entry.plugin}" hook "${hook}"`,
                );
                emitPluginEvent(entry, hook, { phase: "success", durationMs: performanceNow() - startedAt });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn(`plugin "${entry.plugin}" observer "${hook}" failed:`, message);
                recordTrace(entry, hook, {
                  status: "skipped",
                  error: { message },
                  durationMs: performanceNow() - startedAt,
                });
                emitPluginEvent(entry, hook, {
                  phase: err instanceof HookTimeoutError ? "timeout" : "error",
                  error: { message },
                  durationMs: performanceNow() - startedAt,
                });
              }
            }),
          );
        },

        end() {
          stores.clear();
        },
      };
    },
  };

  return host;
}

/**
 * `Date.now()` is fine here (unlike inside workflow scripts) but a monotonic
 * clock gives honest durations across wall-clock adjustments.
 */
function performanceNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}
