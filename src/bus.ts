import { EventEmitter } from "node:events";

/**
 * Normalized event published onto the bus.
 * Keyed by `baseOwner/baseRepo@sha` (fork-safe: base repo is the PR target).
 */
export type NormalizedEvent = {
  owner: string;
  repo: string;
  sha: string;
  type: "check_run" | "check_suite" | "workflow_run" | "pull_request" | "status";
  status: string;
  conclusion: string | null;
  name: string;
  raw?: unknown;
};

export type BusKey = string;

export function busKey(owner: string, repo: string, sha: string): BusKey {
  return `${owner}/${repo}@${sha}`;
}

export type BusHandler = (event: NormalizedEvent) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();
  // Increase limit: one process watches many repos, many SHAs
  private static readonly MAX_LISTENERS = 200;

  constructor() {
    this.emitter.setMaxListeners(EventBus.MAX_LISTENERS);
  }

  publish(event: NormalizedEvent): void {
    const key = busKey(event.owner, event.repo, event.sha);
    this.emitter.emit(key, event);
    // wildcard for debugging / notifications-only logging path
    this.emitter.emit("*", event);
  }

  subscribe(owner: string, repo: string, sha: string, handler: BusHandler): () => void {
    const key = busKey(owner, repo, sha);
    this.emitter.on(key, handler);
    return () => {
      this.emitter.off(key, handler);
    };
  }

  subscribeAll(handler: BusHandler): () => void {
    this.emitter.on("*", handler);
    return () => {
      this.emitter.off("*", handler);
    };
  }

  /** Wait for an event matching predicate, with timeout. Returns event or null on timeout. */
  waitFor(
    owner: string,
    repo: string,
    sha: string,
    predicate: (e: NormalizedEvent) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NormalizedEvent | null> {
    return new Promise((resolve) => {
      const key = busKey(owner, repo, sha);
      let timer: NodeJS.Timeout | undefined;
      let done = false;

      const handler: BusHandler = (e) => {
        if (predicate(e)) {
          if (!done) {
            done = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onAbort);
            this.emitter.off(key, handler);
            resolve(e);
          }
        }
      };

      const onAbort = () => {
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          this.emitter.off(key, handler);
          resolve(null);
        }
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      this.emitter.on(key, handler);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!done) {
            done = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            this.emitter.off(key, handler);
            resolve(null);
          }
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  listenerCount(owner: string, repo: string, sha: string): number {
    return this.emitter.listenerCount(busKey(owner, repo, sha));
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
