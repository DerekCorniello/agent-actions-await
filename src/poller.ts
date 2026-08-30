import { getChecksForSha, type GhAuth, type FetchFn } from "./github.js";
import type { WatchManager } from "./watch-manager.js";

export type PollerOpts = {
  graceMs?: number; // 30s per Q12
  intervalMs?: number; // 15s per Q18
  fetchFn?: FetchFn | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  getAuth?: (owner: string, repo: string) => GhAuth | undefined;
};

/**
 * Fallback safety net (Q12): if no webhook arrives within grace window,
 * poll GitHub REST every interval. Uses exponential backoff via github helpers.
 * This supplements bus-driven completion; it never replaces it.
 */
export class FallbackPoller {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(
    private readonly wm: WatchManager,
    private readonly opts: PollerOpts = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const intervalMs = this.opts.intervalMs ?? 15_000;
    const graceMs = this.opts.graceMs ?? 30_000;
    let first = true;
    const tick = async () => {
      if (this.stopped) return;
      // grace on first tick: wait graceMs before first poll (so webhook has chance)
      if (first) {
        first = false;
        this.timer = setTimeout(() => {
          void this.pollOnce();
          this.timer = setInterval(() => void this.pollOnce(), intervalMs);
          this.timer.unref?.();
        }, graceMs);
        this.timer.unref?.();
        return;
      }
      await this.pollOnce();
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer as unknown as NodeJS.Timeout);
    this.timer = undefined;
  }

  async pollOnce(): Promise<void> {
    const handles = this.wm.pendingHandles();
    for (const h of handles) {
      const st = this.wm.getStatus(h);
      if ("error" in st) continue;
      // peek without consuming GC
      if (st.state !== "pending") continue;
      const auth = this.opts.getAuth?.(st.owner, st.repo);
      try {
        const fresh = await getChecksForSha({
          owner: st.owner,
          repo: st.repo,
          sha: st.sha,
          auth,
          fetchFn: this.opts.fetchFn,
          env: this.opts.env,
        });
        this.wm.applyPolledChecks(h, fresh);
      } catch {
        // swallow per-poll errors (rate limit, network); next interval retries
      }
    }
  }
}
