import { DeskhandError } from "@deskhand/shared";

/** Sleep that rejects as soon as the signal aborts (with the signal's reason). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Throws the signal's reason if aborted. */
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

/**
 * Race a promise against a deadline. On timeout, aborts `controller` (so the work stops at its next
 * check) and rejects with a `timeout` DeskhandError — even if the work itself never settles.
 */
export function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onParent = () => controller.abort(parent!.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new DeskhandError("timeout", `The action did not finish within ${ms} ms; take a screenshot to check the desktop's state.`);
      controller.abort(err);
      reject(err);
    }, ms);
    const done = () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    };
    work(controller.signal).then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
    controller.signal.addEventListener("abort", () => {
      // Parent aborts (control changed) reject immediately too.
      if (!(controller.signal.reason instanceof DeskhandError && controller.signal.reason.code === "timeout")) {
        done();
        reject(controller.signal.reason);
      }
    });
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
