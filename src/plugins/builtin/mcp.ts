/**
 * Lifecycle wrapper for a Model Context Protocol server.
 *
 * An MCP server is not a list of tools, it is a SESSION: something has to open
 * a transport, discover what the server offers, and close it again when the
 * agent goes away. `tools:` can express only the middle third of that, which is
 * why a caller wiring MCP by hand ends up leaking a child process or a socket
 * per agent. A plugin owns `setup` and a disposer, so the session ends when the
 * agent does.
 *
 * The connection itself stays the caller's dependency: `connect` is supplied by
 * them, so `@langchain/mcp-adapters` or an official MCP client never becomes a
 * dependency of this SDK, and any transport — stdio, SSE, streamable HTTP, an
 * in-process fake — works the same way.
 *
 * Connecting happens in `setup` rather than inside the `tools` contribution
 * because that is the only place the host applies `failureMode`. A fail-closed
 * plugin whose server is unreachable must stop the agent from being built: the
 * alternative is an agent that starts happily with none of the tools its
 * instructions tell it to use, and then improvises.
 */

import type { AgentPlugin, PluginFailureMode } from "../types.js";
import type { ToolInterface } from "../../types.js";

export type McpConnection = {
  /** The tools the server advertised. */
  tools: ToolInterface[];
  /** Shut the session down. Called once, when the last agent using it disposes. */
  close?: () => Promise<void> | void;
};

export type McpConfig = {
  /** Opens the session. Owns the client library, the transport and the auth. */
  connect: () => Promise<McpConnection>;
  /**
   * Renames discovered tools to `${prefix}__${name}`. Two servers routinely
   * both export a `search`, and the SDK merges tools by name — without a prefix
   * one silently shadows the other.
   */
  prefix?: string;
  name?: string;
  /** Default `"open"`: an unreachable server degrades the agent, it is not a breach. */
  failureMode?: PluginFailureMode;
  /** Cap on `connect`. Default 30s. */
  timeoutMs?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Rename without touching the caller's object: the same connection is shared by
 * every agent built from this plugin, so a mutated `name` would rename the tool
 * for all of them. `Object.create` keeps the prototype, because a class-based
 * tool carries `invoke`/`call`/`description` there rather than on the instance,
 * and execution is delegated back to the ORIGINAL tool so a server-backed
 * implementation that reads `this.name` still asks for the tool the server
 * actually knows about.
 */
function withPrefix(tool: ToolInterface, prefix: string): ToolInterface {
  const proto = Object.getPrototypeOf(tool) ?? Object.prototype;
  const renamed = Object.assign(Object.create(proto), tool, {
    name: `${prefix}__${tool.name}`,
  }) as ToolInterface;
  if (typeof tool.invoke === "function") {
    renamed.invoke = (input: unknown, options?: unknown) => tool.invoke!(input, options);
  }
  if (typeof tool.call === "function") {
    renamed.call = (input: unknown, options?: unknown) => tool.call!(input, options);
  }
  return renamed;
}

export function mcp(config: McpConfig): AgentPlugin {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  /**
   * One plugin instance is one server session, however many hosts share it.
   * Sub-agents inherit the plugin object and build their own host, so without
   * the memo a delegation would open a second connection — and without the
   * reference count the child's dispose would close the parent's server out
   * from under it.
   */
  let session: Promise<McpConnection> | undefined;
  let holders = 0;
  let discovered: ToolInterface[] = [];

  const connectWithTimeout = async (): Promise<McpConnection> => {
    if (!timeoutMs || timeoutMs <= 0) return config.connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        config.connect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP connect timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      // The host's per-handler timeout covers hooks only — nothing bounds
      // `setup`, so a server that accepts the socket and never answers would
      // otherwise hang agent construction forever.
      if (timer) clearTimeout(timer);
    }
  };

  const acquire = async (): Promise<McpConnection> => {
    session ??= connectWithTimeout();
    try {
      const connection = await session;
      holders += 1;
      return connection;
    } catch (err) {
      // A rejected promise must not be cached: the next agent built from this
      // plugin deserves a real attempt, not a replay of an old outage.
      session = undefined;
      throw err;
    }
  };

  const release = async (): Promise<void> => {
    holders -= 1;
    if (holders > 0) return;
    holders = 0;
    const current = session;
    session = undefined;
    discovered = [];
    const connection = await current?.catch(() => undefined);
    await connection?.close?.();
  };

  return {
    name: config.name ?? "mcp",
    // No hooks, so rank only decides when the session opens relative to other
    // plugins' setup. Late is right: a fail-closed guardrail that refuses to
    // start should do so before a network session is opened, not after.
    priority: 100,
    failureMode: config.failureMode ?? "open",

    setup: async (ctx) => {
      const connection = await acquire();
      const tools = connection.tools ?? [];
      discovered = config.prefix ? tools.map((tool) => withPrefix(tool, config.prefix!)) : [...tools];
      ctx.logger.debug(`mcp: discovered ${discovered.length} tool(s)`);
      ctx.onDispose(release);
    },

    // Resolved by the host immediately after `setup`, so the session is already
    // open by the time this runs.
    tools: () => discovered,
  };
}
