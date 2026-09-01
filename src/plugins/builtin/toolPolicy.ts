/**
 * Central tool policy.
 *
 * Today approval lives on the tool definition (`needsApproval`), which means a
 * policy has to be edited into every tool it governs — including tools that
 * arrived from an MCP server and are not yours to edit. This moves the decision
 * to one place the security owner can read in full.
 *
 * The escalation rule is enforced by the host, not here: a hook can raise a
 * call to `ask` or `deny`, and can never lower one. A policy that could grant
 * `allow` over a tool's own `needsApproval: true` would be a way to switch the
 * approval system off from a plugin.
 */

import type { AgentPlugin } from "../types.js";
import { CONTROL_PLANE_TOOL_NAMES } from "../../smart/toolResponses.js";

export type ToolRule = {
  /** Exact tool name, or a RegExp tested against it. */
  tool: string | RegExp;
  /** What to do when this rule matches. */
  action: "allow" | "ask" | "deny";
  /** Narrow the rule to specific arguments. */
  when?: (args: Record<string, unknown>) => boolean;
  /** Message shown to the reviewer, or handed back to the model on `deny`. */
  reason?: string | ((args: Record<string, unknown>, toolName: string) => string);
};

export type ToolPolicyConfig = {
  /** Evaluated in order; the first match wins. */
  rules?: ToolRule[];
  /** Shorthand: always require approval for these tools. */
  ask?: Array<string | RegExp>;
  /** Shorthand: always refuse these tools. */
  deny?: Array<string | RegExp>;
  /**
   * When set, any tool NOT named here is denied. The strictest useful setting
   * for an agent with dynamically discovered tools.
   *
   * The SDK's own control-plane tools are exempt by default — see
   * `governControlPlaneTools`.
   */
  allowOnly?: Array<string | RegExp>;
  /**
   * Whether `allowOnly` also governs the SDK's own machinery:
   * `ask_user_question`, `manage_plan`, `get_tool_response`, `response`,
   * `open_skill` and friends.
   *
   * Default false. An allow-list is written by naming the tools you care
   * about, and nobody writing one means "also stop the agent from asking me a
   * question or returning its structured output". Governing them silently
   * breaks human-in-the-loop, planning and structured output at once, and the
   * symptom — a run that quietly stops using half the runtime — points nowhere
   * near the policy. Set true to govern them anyway; an explicit `deny` entry
   * or a rule still applies to them either way.
   */
  governControlPlaneTools?: boolean;
  /** Cap executions per tool, per run — a loop-breaker for retry storms. */
  maxExecutionsPerTool?: number | Record<string, number>;
  priority?: number;
  name?: string;
};

function matches(pattern: string | RegExp, toolName: string): boolean {
  return typeof pattern === "string" ? pattern === toolName : pattern.test(toolName);
}

function asObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

export function toolPolicy(config: ToolPolicyConfig = {}): AgentPlugin {
  const rules: ToolRule[] = [
    ...(config.deny ?? []).map((tool) => ({ tool, action: "deny" as const })),
    ...(config.ask ?? []).map((tool) => ({ tool, action: "ask" as const })),
    ...(config.rules ?? []),
  ];

  const limitFor = (toolName: string): number | undefined => {
    const limit = config.maxExecutionsPerTool;
    if (limit === undefined) return undefined;
    return typeof limit === "number" ? limit : limit[toolName];
  };

  return {
    name: config.name ?? "tool-policy",
    priority: config.priority ?? 15,
    failureMode: "closed",

    hooks: {
      preToolUse: ({ toolName, args }, ctx) => {
        const argObject = asObject(args);

        const isControlPlane = CONTROL_PLANE_TOOL_NAMES.includes(toolName);
        const allowListApplies = !isControlPlane || config.governControlPlaneTools === true;

        if (
          config.allowOnly
          && allowListApplies
          && !config.allowOnly.some((pattern) => matches(pattern, toolName))
        ) {
          return {
            decision: "deny",
            reason: `Tool "${toolName}" is not on this agent's allow-list.`,
          };
        }

        const limit = limitFor(toolName);
        if (limit !== undefined) {
          const counts = (ctx.store.__counts ??= {}) as Record<string, number>;
          const used = counts[toolName] ?? 0;
          if (used >= limit) {
            return {
              decision: "deny",
              reason: `Per-run execution limit reached for "${toolName}" (${limit}). Use the results you already have.`,
            };
          }
          counts[toolName] = used + 1;
        }

        for (const rule of rules) {
          if (!matches(rule.tool, toolName)) continue;
          if (rule.when && !rule.when(argObject)) continue;
          const reason =
            typeof rule.reason === "function" ? rule.reason(argObject, toolName) : rule.reason;
          if (rule.action === "deny") {
            return { decision: "deny", reason: reason ?? `Tool "${toolName}" is blocked by policy.` };
          }
          if (rule.action === "ask") {
            return {
              decision: "ask",
              approvalPrompt: reason ?? `Approve "${toolName}"? Arguments: ${JSON.stringify(argObject)}`,
            };
          }
          // An explicit `allow` rule stops evaluation without granting anything
          // the host would not already permit — escalation is one-way.
          return undefined;
        }

        return undefined;
      },
    },
  };
}

/**
 * Path sandbox for filesystem-shaped tools. Rejects absolute escapes, parent
 * traversal, and anything resolving outside the allowed roots.
 */
export function pathSandbox(config: {
  /** Argument names that carry a path. Default: path, file, filePath, dir, directory. */
  argNames?: string[];
  /** Allowed prefixes. A path must start with one of them once normalized. */
  roots: string[];
  /** Only apply to these tools. Default: every tool that carries a path argument. */
  tools?: Array<string | RegExp>;
  name?: string;
  priority?: number;
}): AgentPlugin {
  const argNames = config.argNames ?? ["path", "file", "filePath", "file_path", "dir", "directory"];
  const roots = config.roots.map((root) => root.replace(/\/+$/, ""));

  const normalize = (value: string): string => {
    const segments: string[] = [];
    for (const segment of value.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `${value.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  };

  return {
    name: config.name ?? "path-sandbox",
    priority: config.priority ?? 15,
    failureMode: "closed",
    // Only ever denies, never asks — no reason to serialize the tool batch.
    mayRequireApproval: false,
    hooks: {
      preToolUse: ({ toolName, args }) => {
        if (config.tools && !config.tools.some((pattern) => matches(pattern, toolName))) return undefined;
        const argObject = asObject(args);
        for (const key of argNames) {
          const value = argObject[key];
          if (typeof value !== "string" || value.length === 0) continue;
          const resolved = normalize(value);
          const inside = roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
          if (!inside) {
            return {
              decision: "deny",
              reason: `Path "${value}" is outside the allowed roots (${roots.join(", ")}).`,
            };
          }
        }
        return undefined;
      },
    },
  };
}
