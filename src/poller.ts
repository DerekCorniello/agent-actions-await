import { getChecksForSha, getPrFeedback, getPrInfo, type GhAuth, type FetchFn } from "./github.js";
import type { WatchManager } from "./watch-manager.js";

export type PollerOpts = {
    graceMs?: number;
    intervalMs?: number;
    fetchFn?: FetchFn;
    env?: NodeJS.ProcessEnv;
    getAuth?: (owner: string, repo: string) => GhAuth | undefined;
    getPrInfoFn?: typeof getPrInfo;
    getPrFeedbackFn?: typeof getPrFeedback;
};

/** Reconcile PR lifecycle, current head, checks, and feedback for pending watches. */
export class FallbackPoller {
    private timer: NodeJS.Timeout | undefined;
    private stopped = false;
    private polling = false;

    constructor(
        private readonly wm: WatchManager,
        private readonly opts: PollerOpts = {},
    ) {}

    start(): void {
        if (this.timer) return;
        this.stopped = false;
        const intervalMs = this.opts.intervalMs ?? 15_000;
        const graceMs = this.opts.graceMs ?? 30_000;
        this.timer = setTimeout(() => {
            this.timer = setInterval(() => {
                void this.pollOnce();
            }, intervalMs);
            this.timer.unref?.();
            void this.pollOnce();
        }, graceMs);
        this.timer.unref?.();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            clearInterval(this.timer);
        }
        this.timer = undefined;
    }

    async pollOnce(): Promise<void> {
        if (this.polling || this.stopped) return;
        this.polling = true;
        try {
            for (const handle of this.wm.pendingHandles()) {
                if (this.stopped) break;
                const status = this.wm.getStatus(handle);
                if (!("state" in status) || status.state !== "pending") continue;
                const snapshot = this.wm.getPollSnapshot(handle);
                if (!snapshot) continue;
                const auth = this.opts.getAuth?.(status.owner, status.repo);

                try {
                    const info = await (this.opts.getPrInfoFn ?? getPrInfo)({
                        owner: status.owner,
                        repo: status.repo,
                        prNumber: status.prNumber,
                        auth,
                        fetchFn: this.opts.fetchFn,
                        env: this.opts.env,
                    });
                    await this.wm.reconcilePr(handle, info, snapshot.sha, snapshot.revision);
                    const current = this.wm.getStatus(handle);
                    if (
                        status.mode !== "feedback" &&
                        "state" in current &&
                        current.state === "pending" &&
                        current.sha
                    ) {
                        const checkSnapshot = this.wm.getPollSnapshot(handle);
                        if (checkSnapshot) {
                            const checks = await getChecksForSha({
                                owner: current.owner,
                                repo: current.repo,
                                sha: current.sha,
                                auth,
                                fetchFn: this.opts.fetchFn,
                                env: this.opts.env,
                            });
                            this.wm.applyPolledChecks(
                                handle,
                                checks,
                                current.sha,
                                checkSnapshot.revision,
                            );
                        }
                    }
                } catch (error) {
                    this.wm.recordPollError(handle, error);
                }

                if (status.mode !== "checks") {
                    const latest = this.wm.getStatus(handle);
                    if (!("state" in latest) || latest.state !== "pending") continue;
                    try {
                        const feedback = await (this.opts.getPrFeedbackFn ?? getPrFeedback)({
                            owner: status.owner,
                            repo: status.repo,
                            prNumber: status.prNumber,
                            auth,
                            fetchFn: this.opts.fetchFn,
                            env: this.opts.env,
                        });
                        this.wm.applyPolledFeedback(handle, feedback, snapshot.feedbackRevision);
                    } catch (error) {
                        this.wm.recordPollError(handle, error);
                    }
                }
            }
        } finally {
            this.polling = false;
        }
    }
}
