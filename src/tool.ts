import type { ZodSchema } from "zod";

import type { ToolInterface } from "./types.js";

export type SmartToolFn = (args: any) => Promise<any> | any;

export type ToolCachePolicy = {
  /** Cache scope. "run" persists for the current invoke only. */
  scope?: "run";
  /** Override the cache key (default: stable JSON of args). */
  keyFn?: (args: any) => string;
  /** Time-to-live for the cached value, in ms. Default: full invoke. */
  ttlMs?: number;
};

export type ToolRetryPolicy = {
  /** Max retry attempts after the initial failure. Default: 0. */
  maxRetries?: number;
  /** Initial backoff in ms (doubled on each retry). Default: 250. */
  backoffMs?: number;
  /** Decide whether an error is worth retrying. Default: every error. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /**
   * Open a circuit-breaker after this many consecutive failures across the
   * invoke; once tripped the tool short-circuits with the breaker error
   * until the loop ends. Default: never trip.
   */
  circuitBreakerThreshold?: number;
};

export function createTool({
    name,
    description,
    schema,
    func,
    needsApproval,
    approvalPrompt,
    approvalDefaults,
    maxExecutionsPerRun,
    cache,
    retry,
}: {
    name: string;
    description?: string;
    schema: ZodSchema;
    func: SmartToolFn;
    needsApproval?: boolean;
    approvalPrompt?: string;
    approvalDefaults?: any;
    maxExecutionsPerRun?: number | null;
    /** When set, identical args within the same invoke short-circuit to the cached result. */
    cache?: boolean | ToolCachePolicy;
    /** Per-tool retry + circuit-breaker policy. */
    retry?: ToolRetryPolicy;
}): ToolInterface {
    const execute: SmartToolFn = async (input: any) => func(input);

    const toolRecord: ToolInterface = {
        name,
        description,
        schema,
        // Our runtime prefers invoke but fallback helpers keep compatibility with LC-style tools.
        invoke: execute,
        call: execute,
        run: execute,
        func: execute,
    } as ToolInterface;

    if (typeof needsApproval === "boolean") {
        (toolRecord as any).needsApproval = needsApproval;
    }
    if (approvalPrompt !== undefined) {
        (toolRecord as any).approvalPrompt = approvalPrompt;
    }
    if (approvalDefaults !== undefined) {
        (toolRecord as any).approvalDefaults = approvalDefaults;
    }
    if (maxExecutionsPerRun !== undefined) {
        (toolRecord as any).maxExecutionsPerRun = maxExecutionsPerRun;
    }
    if (cache !== undefined) {
        (toolRecord as any).cache = cache;
    }
    if (retry !== undefined) {
        (toolRecord as any).retry = retry;
    }

    (toolRecord as any).__source = (toolRecord as any).__source || "smart";
    (toolRecord as any).__impl = func;

    return toolRecord;
}
