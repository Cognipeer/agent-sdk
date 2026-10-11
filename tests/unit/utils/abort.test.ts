import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  isCancellationRequested,
  linkAbortSignal,
} from "../../../src/utils/abort.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("linkAbortSignal", () => {
  it("returns nothing to cancel with when no source is given", () => {
    expect(linkAbortSignal(undefined).signal).toBeUndefined();
    expect(linkAbortSignal({}).signal).toBeUndefined();
    expect(linkAbortSignal({ cancellationToken: "nope" }).signal).toBeUndefined();
  });

  it("hands a lone real AbortSignal back untouched", () => {
    const controller = new AbortController();
    const linked = linkAbortSignal({ signal: controller.signal });
    expect(linked.signal).toBe(controller.signal);
    // The same signal passed under both names is still the lone signal.
    expect(linkAbortSignal({ signal: controller.signal, cancellationToken: controller.signal }).signal).toBe(controller.signal);
    linked.dispose();
  });

  it("treats a real signal given as the cancellationToken like any other", () => {
    const controller = new AbortController();
    expect(linkAbortSignal({ cancellationToken: controller.signal }).signal).toBe(controller.signal);
  });

  it("aborts at once when the source is already cancelled", () => {
    const linked = linkAbortSignal({ cancellationToken: { isCancellationRequested: true } });
    expect(linked.signal?.aborted).toBe(true);
    linked.dispose();

    const alreadyAborted = linkAbortSignal({ signal: { aborted: true } });
    expect(alreadyAborted.signal?.aborted).toBe(true);
  });

  it("turns a flag-only token into a signal that fires when the flag flips", async () => {
    vi.useFakeTimers();
    const token = { isCancellationRequested: false };
    const linked = linkAbortSignal({ cancellationToken: token });
    expect(linked.signal).toBeInstanceOf(AbortSignal);
    expect(linked.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(linked.signal?.aborted).toBe(false);

    token.isCancellationRequested = true;
    await vi.advanceTimersByTimeAsync(150);
    expect(linked.signal?.aborted).toBe(true);
    linked.dispose();
  });

  it("uses a token's listener when it offers one, and disposes the subscription", () => {
    let fire: (() => void) | undefined;
    const dispose = vi.fn();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        fire = listener;
        return { dispose };
      },
    };
    const linked = linkAbortSignal({ cancellationToken: token });
    expect(linked.signal?.aborted).toBe(false);
    fire?.();
    expect(linked.signal?.aborted).toBe(true);
    linked.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("follows a signal-like object that is not a real AbortSignal", () => {
    const target = new EventTarget() as EventTarget & { aborted: boolean };
    target.aborted = false;
    const linked = linkAbortSignal({ signal: target });
    expect(linked.signal).toBeInstanceOf(AbortSignal);
    expect(linked.signal?.aborted).toBe(false);
    target.aborted = true;
    target.dispatchEvent(new Event("abort"));
    expect(linked.signal?.aborted).toBe(true);
  });

  it("aborts when either of a signal and a token fires, and keeps the signal's reason", () => {
    const controller = new AbortController();
    const token = { isCancellationRequested: false };
    const linked = linkAbortSignal({ signal: controller.signal, cancellationToken: token });
    expect(linked.signal).not.toBe(controller.signal);
    controller.abort(new Error("stop"));
    expect(linked.signal?.aborted).toBe(true);
    expect((linked.signal?.reason as Error).message).toBe("stop");
    linked.dispose();
  });

  it("stops polling once disposed", async () => {
    vi.useFakeTimers();
    const token = { isCancellationRequested: false };
    const linked = linkAbortSignal({ cancellationToken: token });
    linked.dispose();
    token.isCancellationRequested = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(linked.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isCancellationRequested", () => {
  it("reads either spelling", () => {
    expect(isCancellationRequested(undefined)).toBe(false);
    expect(isCancellationRequested({ signal: new AbortController().signal })).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(isCancellationRequested({ signal: controller.signal })).toBe(true);
    expect(isCancellationRequested({ cancellationToken: { isCancellationRequested: true } })).toBe(true);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay when nothing aborts", async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = abortableSleep(1_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await sleeping;
    expect(done).toBe(true);
  });

  it("rejects as soon as the signal aborts instead of sitting out the delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    const outcome = sleeping.then(() => "slept", (e) => `rejected:${e?.name}`);
    controller.abort();
    expect(await outcome).toBe("rejected:AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(60_000, controller.signal)).rejects.toBeDefined();
  });
});
