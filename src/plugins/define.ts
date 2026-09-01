import type { AgentPlugin, HookHandler, HookName, PluginFailureMode } from "./types.js";

/**
 * Wrap a plugin factory so config flows through with full inference:
 *
 *   const myGuard = definePlugin<{ level: number }>((cfg) => ({ name: "my-guard", ... }));
 *   myGuard({ level: 2 })
 *
 * The indirection buys nothing at runtime — it exists so the config type is
 * inferred at the call site and the returned object is checked against
 * `AgentPlugin` at the definition site, where the error message is useful.
 */
export function definePlugin<TConfig = void>(
  factory: (config: TConfig) => AgentPlugin,
): (config: TConfig) => AgentPlugin {
  return (config: TConfig) => {
    const plugin = factory(config);
    if (!plugin || typeof plugin.name !== "string" || plugin.name.length === 0) {
      throw new Error("[agent-sdk] definePlugin: the factory must return a plugin with a non-empty `name`.");
    }
    return plugin;
  };
}

/**
 * A single hook, packaged as a plugin. For the common case where naming and a
 * lifecycle would be ceremony:
 *
 *   defineHook("preToolUse", ({ toolName }) => toolName === "shell" ? { decision: "ask" } : undefined)
 */
export function defineHook<K extends HookName>(
  hook: K,
  handler: HookHandler<K>,
  opts?: {
    name?: string;
    priority?: number;
    failureMode?: PluginFailureMode;
    timeoutMs?: number;
    inheritToSubagents?: boolean;
    /**
     * Declare that this hook never returns `decision: "ask"`. Without it a
     * `preToolUse` hook is assumed to be able to pause, and the whole tool
     * batch is scheduled serially — silently costing an agent its parallel
     * tool execution.
     */
    mayRequireApproval?: boolean;
  },
): AgentPlugin {
  return {
    name: opts?.name ?? `hook:${hook}`,
    priority: opts?.priority,
    failureMode: opts?.failureMode,
    timeoutMs: opts?.timeoutMs,
    inheritToSubagents: opts?.inheritToSubagents,
    mayRequireApproval: opts?.mayRequireApproval,
    hooks: { [hook]: handler } as AgentPlugin["hooks"],
  };
}
