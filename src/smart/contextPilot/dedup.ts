// Cross-turn duplicate detection: flags when a tool output's content is
// byte-identical to a previously seen output within the same invoke() run,
// so the duplicate can be replaced with a lightweight pointer.

import { createHash } from "node:crypto";

type DedupEntry = { executionId: string; toolName: string };

export class DedupTracker {
  private seen = new Map<string, DedupEntry>();

  /**
   * Registers `content` under `executionId`/`toolName`. Returns the entry
   * that first produced this exact content, or `undefined` if this is the
   * first time it has been seen.
   */
  checkAndRegister(content: string, executionId: string, toolName: string): DedupEntry | undefined {
    const hash = createHash("sha1").update(content).digest("hex");
    const existing = this.seen.get(hash);
    if (!existing) {
      this.seen.set(hash, { executionId, toolName });
    }
    return existing;
  }
}
