/**
 * Cancellation plumbing between the agent loop and the HTTP request of a model
 * call.
 *
 * A run can be cancelled in three spellings, and a host picks whichever its own
 * stack already has:
 *
 *  - a real `AbortSignal` (`controller.signal`), passed as `signal` or as
 *    `cancellationToken`;
 *  - a `CancellationTokenLike` (`isCancellationRequested`, optionally with an
 *    `onCancellationRequested` listener) as in VS Code style APIs;
 *  - a bare `{ aborted }` object that is not a real signal.
 *
 * `fetch` only understands the first. Everything else has to be turned into one,
 * or the model request keeps streaming after the run was told to stop — the
 * agent loop walks away from the stream, but the connection (and the provider's
 * bill) stays open until the model finishes.
 */

export type AbortSource = {
  signal?: unknown;
  cancellationToken?: unknown;
};

export type LinkedAbort = {
  /** A real `AbortSignal` to hand to `fetch`, or undefined when nothing can cancel the call. */
  signal: AbortSignal | undefined;
  /** Releases listeners and timers. Always call it when the model call ends. */
  dispose(): void;
};

/** How often a token that only exposes a flag is sampled while a call is in flight. */
const POLL_INTERVAL_MS = 100;

const NOOP = () => undefined;

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

function isRealSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

/** True when the caller has asked the run to stop, in either spelling. */
export function isCancellationRequested(source?: AbortSource | null): boolean {
  if (!source) return false;
  for (const candidate of [source.signal, source.cancellationToken]) {
    if (!isObject(candidate)) continue;
    if (candidate.aborted === true || candidate.isCancellationRequested === true) return true;
  }
  return false;
}

/**
 * Builds the `AbortSignal` for one model call from whatever the run was given.
 *
 * The common case — one real signal — is returned untouched, so a host that
 * already passes `controller.signal` pays nothing. Any other combination gets
 * a controller of its own that fires when the first source does.
 */
export function linkAbortSignal(source?: AbortSource | null): LinkedAbort {
  if (!source) return { signal: undefined, dispose: NOOP };

  const candidates: Array<Record<string, any>> = [];
  for (const candidate of [source.signal, source.cancellationToken]) {
    if (isObject(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) return { signal: undefined, dispose: NOOP };

  const real = candidates.filter(isRealSignal);
  if (candidates.length === 1 && real.length === 1) {
    return { signal: real[0], dispose: NOOP };
  }

  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  let polled: Array<Record<string, any>> = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const fire = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  };

  const dispose = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    polled = [];
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* a listener that cannot be removed has nothing left to leak */
      }
    }
  };

  for (const candidate of candidates) {
    if (candidate.aborted === true || candidate.isCancellationRequested === true) {
      fire(isRealSignal(candidate) ? candidate.reason : undefined);
      return { signal: controller.signal, dispose };
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate.addEventListener === "function") {
      const onAbort = () => fire(isRealSignal(candidate) ? candidate.reason : undefined);
      candidate.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => candidate.removeEventListener?.("abort", onAbort));
      continue;
    }
    if (typeof candidate.onCancellationRequested === "function") {
      let handle: unknown;
      try {
        handle = candidate.onCancellationRequested(() => fire());
      } catch {
        handle = undefined;
      }
      if (isObject(handle) && typeof handle.dispose === "function") {
        cleanups.push(() => (handle as { dispose(): void }).dispose());
      }
      // A listener-capable token is trusted to call back; sampling it as well
      // costs nothing and covers one that only fires for later subscribers.
      polled.push(candidate);
      continue;
    }
    if ("isCancellationRequested" in candidate || "aborted" in candidate) {
      polled.push(candidate);
    }
  }

  if (polled.length > 0) {
    timer = setInterval(() => {
      for (const candidate of polled) {
        if (candidate.aborted === true || candidate.isCancellationRequested === true) {
          fire();
          dispose();
          return;
        }
      }
    }, POLL_INTERVAL_MS);
    // A forgotten timer must never keep a finished process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  return { signal: controller.signal, dispose };
}

/** A `setTimeout` that rejects as soon as the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The error to throw for an aborted signal: its own reason when it has one. */
export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
