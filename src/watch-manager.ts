import { randomUUID } from "node:crypto";
import type { EventBus, NormalizedEvent } from "./bus.js";
import {
    getPrInfo,
    getPrFeedback,
    getChecksForSha,
    filterChecks,
    allSettled,
    summarize,
    type CheckInfo,
    type getChecksForShaWithGrace,
    type CheckFilter,
    type FetchFn,
    type GhAuth,
    type PrInfo,
} from "./github.js";
import type { FeedbackItem } from "./feedback.js";

type Check = CheckInfo & { id?: string; runId?: number; url?: string };
type StartArgs = {
    owner: string;
    repo: string;
    prNumber: number;
    filter?: CheckFilter;
    mode?: "checks" | "feedback" | "both";
    feedbackAuthors?: string[];
    feedbackQuietMs?: number;
    timeoutMs?: number;
    auth?: GhAuth;
    fetchFn?: FetchFn;
    env?: NodeJS.ProcessEnv;
};

export type WatchStatus = {
    handle: string;
    owner: string;
    repo: string;
    prNumber: number;
    sha: string;
    filter: CheckFilter;
    mode: "checks" | "feedback" | "both";
    feedbackAuthors?: string[];
    feedback: FeedbackItem[];
    checksState: "waiting" | "ready" | "not_required";
    feedbackState: "waiting" | "ready" | "not_required";
    state: "pending" | "completed" | "timed_out" | "failed" | "cancelled";
    error?: string;
    lastPollError?: string;
    completionReason?:
        "checks_settled" | "feedback_received" | "checks_and_feedback" | "pr_closed" | "pr_merged";
    checks: Check[];
    pending: Check[];
    completed: Check[];
    createdAt: number;
    updatedAt: number;
};
export type WatchEntry = {
    status: WatchStatus;
    unsub: () => void;
    timer?: NodeJS.Timeout;
    gcTimer?: NodeJS.Timeout;
    generation: number;
    args: StartArgs;
    settleTimer?: NodeJS.Timeout | undefined;
    revision: number;
    earlyEvents: NormalizedEvent[];
    eventChecks: Map<string, { check: Check; revision: number }>;
    feedbackQuietTimer?: NodeJS.Timeout | undefined;
    feedbackBaselineReady: boolean;
    feedbackBaseline: Map<string, string>;
    feedbackItems: Map<string, FeedbackItem>;
    queuedFeedback: FeedbackItem[];
    feedbackRevision: number;
};
export type WatchManagerOpts = {
    defaultTimeoutMs?: number;
    graceMs?: number;
    pollIntervalMs?: number;
    gcAfterMs?: number;
    settleMs?: number;
    feedbackQuietMs?: number;
};

export class WatchManager {
    private readonly watches = new Map<string, WatchEntry>();
    private readonly dedup = new Map<string, string>();
    private readonly bus: EventBus;
    private readonly getPrInfoFn: typeof getPrInfo;
    private readonly getChecksFn: typeof getChecksForShaWithGrace;
    private readonly getPrFeedbackFn: typeof getPrFeedback;
    private readonly opts: Required<WatchManagerOpts>;

    constructor(
        bus: EventBus,
        deps?: {
            getPrInfoFn?: typeof getPrInfo;
            getChecksFn?: typeof getChecksForShaWithGrace;
            getPrFeedbackFn?: typeof getPrFeedback;
        },
        opts?: WatchManagerOpts,
    ) {
        this.bus = bus;
        this.getPrInfoFn = deps?.getPrInfoFn ?? getPrInfo;
        this.getChecksFn =
            deps?.getChecksFn ?? (getChecksForSha as typeof getChecksForShaWithGrace);
        this.getPrFeedbackFn = deps?.getPrFeedbackFn ?? getPrFeedback;
        this.opts = {
            defaultTimeoutMs: opts?.defaultTimeoutMs ?? 600_000,
            graceMs: opts?.graceMs ?? 60_000,
            pollIntervalMs: opts?.pollIntervalMs ?? 2000,
            gcAfterMs: opts?.gcAfterMs ?? 5 * 60_000,
            settleMs: opts?.settleMs ?? 500,
            feedbackQuietMs: opts?.feedbackQuietMs ?? 2000,
        };
    }

    /** The returned promise resolves with a usable handle before any GitHub request completes. */
    async startWatch(args: StartArgs): Promise<string> {
        const filter = args.filter ?? "all";
        const normalizedFilter =
            filter === "all"
                ? filter
                : [...new Set(Array.isArray(filter) ? filter : [filter])].sort();
        const filterKey = JSON.stringify(normalizedFilter);
        const mode = args.mode ?? "checks";
        const timeoutMs = args.timeoutMs ?? this.opts.defaultTimeoutMs;
        const authKey = JSON.stringify([args.auth?.apiBase ?? "", args.auth?.token ?? ""]);
        const feedbackAuthors = args.feedbackAuthors
            ?.map((author) => author.toLocaleLowerCase())
            .sort();
        const dedupKey = `${args.owner}/${args.repo}#${args.prNumber}|${mode}|${filterKey}|${timeoutMs}|${authKey}|${JSON.stringify(feedbackAuthors)}|${args.feedbackQuietMs ?? this.opts.feedbackQuietMs}`;
        const existing = this.dedup.get(dedupKey);
        if (existing && this.watches.has(existing)) return existing;
        const handle = randomUUID();
        const now = Date.now();
        const entry: WatchEntry = {
            status: {
                handle,
                owner: args.owner,
                repo: args.repo,
                prNumber: args.prNumber,
                sha: "",
                filter,
                mode,
                ...(args.feedbackAuthors ? { feedbackAuthors: [...args.feedbackAuthors] } : {}),
                feedback: [],
                checksState: mode === "feedback" ? "not_required" : "waiting",
                feedbackState: mode === "checks" ? "not_required" : "waiting",
                state: "pending",
                checks: [],
                pending: [],
                completed: [],
                createdAt: now,
                updatedAt: now,
            },
            unsub: () => {},
            generation: 0,
            revision: 0,
            args,
            earlyEvents: [],
            eventChecks: new Map(),
            feedbackBaselineReady: mode === "checks",
            feedbackBaseline: new Map(),
            feedbackItems: new Map(),
            queuedFeedback: [],
            feedbackRevision: 0,
        };
        this.watches.set(handle, entry);
        this.dedup.set(dedupKey, handle);
        entry.unsub = this.bus.subscribeAll((evt) => this.onEvent(handle, evt));
        if (timeoutMs > 0) {
            entry.timer = setTimeout(() => this.settle(entry, "timed_out"), timeoutMs);
            entry.timer.unref?.();
        }
        setImmediate(() => {
            void this.initialize(entry);
        });
        return handle;
    }

    private async initialize(entry: WatchEntry): Promise<void> {
        if (entry.status.mode !== "feedback") void this.initializeChecks(entry);
        else void this.initializeFeedbackPr(entry);
        if (entry.status.mode !== "checks") void this.initializeFeedback(entry);
    }

    private async initializeFeedbackPr(entry: WatchEntry): Promise<void> {
        if (!this.isCurrent(entry) || entry.status.sha) return;
        const generation = entry.generation;
        try {
            const info = await this.getPrInfoFn({ ...entry.args });
            if (!this.isCurrent(entry, generation)) return;
            if (info.merged) {
                this.settle(entry, "completed", "pr_merged");
                return;
            }
            if (info.state === "closed") {
                this.settle(entry, "completed", "pr_closed");
                return;
            }
            entry.status.sha = info.sha;
            entry.status.updatedAt = Date.now();
        } catch (error) {
            if (this.isCurrent(entry, generation)) this.fail(entry, error);
        }
    }

    private async initializeChecks(entry: WatchEntry): Promise<void> {
        if (!this.isCurrent(entry) || entry.status.sha) return;
        const initialGeneration = entry.generation;
        try {
            const info = await this.getPrInfoFn({ ...entry.args });
            if (!this.isCurrent(entry) || entry.generation !== initialGeneration) return;
            if (info.merged) {
                this.settle(entry, "completed", "pr_merged");
                return;
            }
            if (info.state === "closed") {
                this.settle(entry, "completed", "pr_closed");
                return;
            }
            await this.moveToSha(entry, info.sha);
        } catch (error) {
            if (this.isCurrent(entry, initialGeneration)) this.fail(entry, error);
        }
    }

    private async initializeFeedback(entry: WatchEntry): Promise<void> {
        if (!this.isCurrent(entry)) return;
        try {
            const items = await this.getPrFeedbackFn({
                owner: entry.status.owner,
                repo: entry.status.repo,
                prNumber: entry.status.prNumber,
                auth: entry.args.auth,
                fetchFn: entry.args.fetchFn,
                env: entry.args.env,
            });
            if (!this.isCurrent(entry)) return;
            for (const item of items) {
                entry.feedbackBaseline.set(item.id, this.feedbackFingerprint(item));
                // GitHub timestamps are commonly rounded to seconds. Include the start
                // second so an item created during baseline fetch cannot be lost.
                const startSecond = Math.floor(entry.status.createdAt / 1000) * 1000;
                if (this.feedbackTimestamp(item) >= startSecond) {
                    this.recordFeedback(entry, item);
                }
            }
            entry.feedbackBaselineReady = true;
            for (const item of entry.queuedFeedback.splice(0)) {
                if (entry.feedbackBaseline.get(item.id) !== this.feedbackFingerprint(item)) {
                    this.recordFeedback(entry, item);
                }
            }
            this.updateFeedbackList(entry);
        } catch (error) {
            if (this.isCurrent(entry)) this.fail(entry, error);
        }
    }

    private feedbackTimestamp(item: FeedbackItem): number {
        return Math.max(Date.parse(item.createdAt), Date.parse(item.updatedAt));
    }

    private feedbackFingerprint(item: FeedbackItem): string {
        return JSON.stringify([
            item.updatedAt,
            item.body,
            item.state ?? "",
            item.path ?? "",
            item.line ?? null,
            item.commitId ?? "",
        ]);
    }

    private acceptsAuthor(entry: WatchEntry, item: FeedbackItem): boolean {
        const authors = entry.status.feedbackAuthors;
        return (
            !authors?.length ||
            authors.some((author) => author.toLocaleLowerCase() === item.author.toLocaleLowerCase())
        );
    }

    private recordFeedback(entry: WatchEntry, item: FeedbackItem): boolean {
        if (!this.acceptsAuthor(entry, item)) return false;
        const existing = entry.feedbackItems.get(item.id);
        const nextFingerprint = this.feedbackFingerprint(item);
        if (existing && this.feedbackFingerprint(existing) === nextFingerprint) return false;
        if (existing && Date.parse(item.updatedAt) < Date.parse(existing.updatedAt)) return false;
        entry.feedbackItems.set(item.id, item);
        entry.feedbackRevision++;
        entry.status.feedbackState = "waiting";
        if (entry.feedbackQuietTimer) clearTimeout(entry.feedbackQuietTimer);
        const quietMs = entry.args.feedbackQuietMs ?? this.opts.feedbackQuietMs;
        entry.feedbackQuietTimer = setTimeout(() => {
            entry.feedbackQuietTimer = undefined;
            if (!this.isCurrent(entry)) return;
            entry.status.feedbackState = "ready";
            entry.status.updatedAt = Date.now();
            this.maybeFinish(entry);
        }, quietMs);
        entry.feedbackQuietTimer.unref?.();
        return true;
    }

    private recordFeedbackEvent(entry: WatchEntry, item: FeedbackItem): boolean {
        if (entry.feedbackBaseline.get(item.id) === this.feedbackFingerprint(item)) return false;
        return this.recordFeedback(entry, item);
    }

    private updateFeedbackList(entry: WatchEntry): void {
        entry.status.feedback = [...entry.feedbackItems.values()].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        entry.status.updatedAt = Date.now();
    }

    private isCurrent(entry: WatchEntry, generation?: number): boolean {
        return (
            this.watches.get(entry.status.handle) === entry &&
            entry.status.state === "pending" &&
            (generation === undefined || generation === entry.generation)
        );
    }

    private async moveToSha(entry: WatchEntry, sha: string): Promise<void> {
        if (!this.isCurrent(entry) || !sha) return;
        if (entry.status.mode === "feedback") {
            entry.status.sha = sha;
            entry.generation++;
            entry.status.updatedAt = Date.now();
            return;
        }
        if (sha !== entry.status.sha) {
            entry.status.sha = sha;
            entry.status.checks = [];
            entry.status.pending = [];
            entry.status.completed = [];
            entry.status.checksState = "waiting";
            entry.eventChecks.clear();
            if (entry.settleTimer) clearTimeout(entry.settleTimer);
            entry.settleTimer = undefined;
        }
        entry.generation++;
        const generation = entry.generation;
        const requestRevision = entry.revision;
        try {
            const checks = await this.getChecksFn({
                ...entry.args,
                sha,
                graceMs: this.opts.graceMs,
                pollIntervalMs: this.opts.pollIntervalMs,
            });
            if (!this.isCurrent(entry, generation)) return;
            this.applyChecks(entry, checks, requestRevision);
            if (entry.earlyEvents.length) {
                const events = entry.earlyEvents.splice(0);
                for (const event of events) this.onEvent(entry.status.handle, event);
            }
        } catch (error) {
            if (this.isCurrent(entry, generation)) this.fail(entry, error);
        }
    }

    private onEvent(handle: string, evt: NormalizedEvent): void {
        const entry = this.watches.get(handle);
        if (!entry || entry.status.state !== "pending") return;
        if (evt.owner !== entry.status.owner || evt.repo !== entry.status.repo) return;
        if (evt.type === "feedback") {
            if (
                (entry.status.mode !== "feedback" && entry.status.mode !== "both") ||
                evt.prNumber !== entry.status.prNumber ||
                !evt.feedback
            )
                return;
            if (!entry.feedbackBaselineReady) entry.queuedFeedback.push(evt.feedback);
            else if (this.recordFeedbackEvent(entry, evt.feedback)) this.updateFeedbackList(entry);
            return;
        }
        if (!entry.status.sha && evt.type !== "pull_request") {
            entry.earlyEvents.push(evt);
            return;
        }
        if (evt.type === "pull_request") {
            if (evt.name !== `pr:${entry.status.prNumber}`) return;
            if (evt.status === "closed" || evt.status === "merged") {
                this.settle(
                    entry,
                    "completed",
                    evt.status === "merged" ? "pr_merged" : "pr_closed",
                );
                return;
            }
            if (evt.sha && evt.sha !== entry.status.sha) void this.moveToSha(entry, evt.sha);
            return;
        }
        if (evt.type !== "check_run" && evt.type !== "status") return;
        if (evt.sha !== entry.status.sha) return;
        if (entry.status.filter !== "all") {
            const wanted = Array.isArray(entry.status.filter)
                ? entry.status.filter
                : [entry.status.filter];
            if (!wanted.includes(evt.name)) return;
        }
        const check = evt as NormalizedEvent & { id?: string; runId?: number; url?: string };
        const match = (c: Check) =>
            check.id !== undefined
                ? c.id === check.id
                : check.runId !== undefined
                  ? c.runId === check.runId
                  : c.name === check.name;
        const current = entry.status.checks.findIndex(match);
        const updated: Check = {
            name: evt.name,
            status: evt.status,
            conclusion: evt.conclusion,
            sha: evt.sha,
            ...(check.id === undefined ? {} : { id: check.id }),
            ...(check.runId === undefined ? {} : { runId: check.runId }),
            ...(check.url === undefined ? {} : { url: check.url }),
        };
        entry.revision++;
        entry.eventChecks.set(this.checkKey(updated), { check: updated, revision: entry.revision });
        if (current < 0) entry.status.checks.push(updated);
        else entry.status.checks[current] = updated;
        entry.status.checksState = "waiting";
        this.refreshSummary(entry);
        this.maybeComplete(entry);
    }

    private applyChecks(
        entry: WatchEntry,
        checks: CheckInfo[],
        requestRevision = entry.revision,
        scheduleCompletion = true,
    ): void {
        entry.status.checksState = "waiting";
        const relevant = [...filterChecks(checks, entry.status.filter)] as Check[];
        for (const eventUpdate of entry.eventChecks.values()) {
            if (eventUpdate.revision <= requestRevision) continue;
            const eventCheck = eventUpdate.check;
            const key = this.checkKey(eventCheck);
            const index = relevant.findIndex((check) => this.checkKey(check) === key);
            if (index < 0) relevant.push(eventCheck);
            else relevant[index] = eventCheck;
        }
        entry.status.checks = relevant;
        this.refreshSummary(entry);
        if (scheduleCompletion) this.maybeComplete(entry);
    }

    private checkKey(check: Check): string {
        if (check.id !== undefined) return `id:${check.id}`;
        if (check.runId !== undefined) return `run:${check.runId}`;
        return `name:${check.name}`;
    }

    private refreshSummary(entry: WatchEntry): void {
        const summary = summarize(entry.status.checks);
        entry.status.pending = summary.pending as Check[];
        entry.status.completed = summary.completed as Check[];
        entry.status.updatedAt = Date.now();
    }

    private maybeComplete(entry: WatchEntry): void {
        if (entry.status.mode === "feedback") return;
        if (!this.isCurrent(entry) || !allSettled(entry.status.checks)) return;
        if (entry.status.filter !== "all") {
            const requested = Array.isArray(entry.status.filter)
                ? entry.status.filter
                : [entry.status.filter];
            if (
                !requested.every((name) => entry.status.checks.some((check) => check.name === name))
            )
                return;
        }
        if (entry.settleTimer) clearTimeout(entry.settleTimer);
        const generation = entry.generation;
        const revision = entry.revision;
        const feedbackRevision = entry.feedbackRevision;
        entry.settleTimer = setTimeout(() => {
            entry.settleTimer = undefined;
            void this.confirmCompletion(entry, generation, revision, feedbackRevision);
        }, this.opts.settleMs);
        entry.settleTimer.unref?.();
    }

    private async confirmCompletion(
        entry: WatchEntry,
        generation: number,
        revision: number,
        feedbackRevision: number,
    ): Promise<void> {
        if (
            !this.isCurrent(entry, generation) ||
            entry.revision !== revision ||
            entry.feedbackRevision !== feedbackRevision ||
            !this.hasCompleteSet(entry.status) ||
            !allSettled(entry.status.checks)
        )
            return;
        try {
            const info = await this.getPrInfoFn({ ...entry.args });
            if (
                !this.isCurrent(entry, generation) ||
                entry.revision !== revision ||
                entry.feedbackRevision !== feedbackRevision
            )
                return;
            if (info.merged) {
                this.settle(entry, "completed", "pr_merged");
                return;
            }
            if (info.state === "closed") {
                this.settle(entry, "completed", "pr_closed");
                return;
            }
            if (info.sha !== entry.status.sha) {
                await this.moveToSha(entry, info.sha);
                return;
            }
            const fresh = await this.getChecksFn({
                ...entry.args,
                sha: info.sha,
                graceMs: 0,
                pollIntervalMs: this.opts.pollIntervalMs,
            });
            if (
                !this.isCurrent(entry, generation) ||
                entry.revision !== revision ||
                entry.feedbackRevision !== feedbackRevision
            )
                return;
            this.applyChecks(entry, fresh, revision, false);
            if (
                this.isCurrent(entry, generation) &&
                this.hasCompleteSet(entry.status) &&
                allSettled(entry.status.checks)
            ) {
                entry.status.checksState = "ready";
                entry.status.updatedAt = Date.now();
                this.maybeFinish(entry);
            }
        } catch (error) {
            if (this.isCurrent(entry, generation)) this.fail(entry, error);
        }
    }

    private maybeFinish(entry: WatchEntry): void {
        if (!this.isCurrent(entry)) return;
        const checksReady = entry.status.checksState === "ready";
        const feedbackReady = entry.status.feedbackState === "ready";
        if (entry.status.mode === "checks") {
            if (!checksReady) return;
            this.settle(entry, "completed", "checks_settled");
            return;
        }
        if (entry.status.mode === "feedback") {
            if (!feedbackReady) return;
            this.settle(entry, "completed", "feedback_received");
            return;
        }
        if (!checksReady && !feedbackReady) return;
        const reason =
            checksReady && feedbackReady
                ? "checks_and_feedback"
                : checksReady
                  ? "checks_settled"
                  : "feedback_received";
        this.settle(entry, "completed", reason);
    }

    private hasCompleteSet(status: WatchStatus): boolean {
        if (status.filter === "all") return status.checks.length > 0;
        const requested = Array.isArray(status.filter) ? status.filter : [status.filter];
        return requested.every((name) => status.checks.some((check) => check.name === name));
    }

    private fail(entry: WatchEntry, error: unknown): void {
        entry.status.error = error instanceof Error ? error.message : String(error);
        this.settle(entry, "failed");
    }

    private settle(
        entry: WatchEntry,
        state: WatchStatus["state"],
        reason?: WatchStatus["completionReason"],
    ): void {
        if (entry.status.state !== "pending") return;
        entry.status.state = state;
        if (reason) entry.status.completionReason = reason;
        entry.status.updatedAt = Date.now();
        for (const [key, handle] of this.dedup)
            if (handle === entry.status.handle) this.dedup.delete(key);
        entry.unsub();
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.settleTimer) clearTimeout(entry.settleTimer);
        if (entry.feedbackQuietTimer) clearTimeout(entry.feedbackQuietTimer);
        this.scheduleGc(entry);
    }

    private scheduleGc(entry: WatchEntry): void {
        entry.gcTimer = setTimeout(() => this.remove(entry.status.handle), this.opts.gcAfterMs);
        entry.gcTimer.unref?.();
    }

    private remove(handle: string): void {
        const entry = this.watches.get(handle);
        if (!entry) return;
        entry.unsub();
        for (const timer of [
            entry.timer,
            entry.gcTimer,
            entry.settleTimer,
            entry.feedbackQuietTimer,
        ])
            if (timer) clearTimeout(timer);
        this.watches.delete(handle);
        for (const [key, value] of this.dedup) if (value === handle) this.dedup.delete(key);
    }

    getStatus(handle: string): WatchStatus | { error: string; hint?: string } {
        const entry = this.watches.get(handle);
        if (!entry) return { error: "handle_not_found", hint: "watch expired or unknown handle" };
        return {
            ...entry.status,
            feedback: [...entry.status.feedback],
            ...(entry.status.feedbackAuthors
                ? { feedbackAuthors: [...entry.status.feedbackAuthors] }
                : {}),
            checks: [...entry.status.checks],
            pending: [...entry.status.pending],
            completed: [...entry.status.completed],
        };
    }

    cancelWatch(handle: string): boolean {
        const entry = this.watches.get(handle);
        if (!entry || entry.status.state !== "pending") return false;
        this.settle(entry, "cancelled");
        return true;
    }
    close(handle: string): boolean {
        if (!this.watches.has(handle)) return false;
        this.remove(handle);
        return true;
    }

    async awaitWatch(
        args: StartArgs,
        notify?: (evt: NormalizedEvent) => void,
    ): Promise<WatchStatus> {
        const handle = await this.startWatch(args);
        const unnotify = notify
            ? this.bus.subscribeAll((evt) => {
                  if (evt.owner === args.owner && evt.repo === args.repo) notify(evt);
              })
            : () => {};
        return new Promise((resolve) => {
            const poll = setInterval(() => {
                const status = this.getStatus(handle);
                if (!("state" in status)) {
                    clearInterval(poll);
                    unnotify();
                    resolve({
                        handle,
                        owner: args.owner,
                        repo: args.repo,
                        prNumber: args.prNumber,
                        sha: "",
                        filter: args.filter ?? "all",
                        mode: args.mode ?? "checks",
                        ...(args.feedbackAuthors
                            ? { feedbackAuthors: [...args.feedbackAuthors] }
                            : {}),
                        feedback: [],
                        checksState: "waiting",
                        feedbackState: "waiting",
                        state: "failed",
                        error: "watch handle expired",
                        checks: [],
                        pending: [],
                        completed: [],
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    });
                    return;
                }
                if (status.state !== "pending") {
                    clearInterval(poll);
                    unnotify();
                    resolve(status);
                }
            }, 10);
            poll.unref?.();
        });
    }

    /** Wait for a bounded window; expiry returns pending and leaves the watch running. */
    async waitForWatch(
        handle: string,
        signal?: AbortSignal,
        waitMs = 30_000,
    ): Promise<WatchStatus | null> {
        const initial = this.getStatus(handle);
        if (!("state" in initial)) return null;
        if (initial.state !== "pending") return initial;
        return new Promise((resolve) => {
            let done = false;
            const finish = (value: WatchStatus | null) => {
                if (done) return;
                done = true;
                clearInterval(interval);
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve(value);
            };
            const check = () => {
                const status = this.getStatus(handle);
                if (!("state" in status)) finish(null);
                else if (status.state !== "pending") finish(status);
            };
            const onAbort = () => finish(null);
            const interval = setInterval(check, 20);
            const timer = setTimeout(
                () => {
                    const latest = this.getStatus(handle);
                    finish("state" in latest ? latest : null);
                },
                Math.max(0, waitMs),
            );
            interval.unref?.();
            timer.unref?.();
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
            else check();
        });
    }

    handleCount(): number {
        return this.watches.size;
    }
    pendingHandles(): string[] {
        return [...this.watches].filter(([, e]) => e.status.state === "pending").map(([h]) => h);
    }

    /** Poll reconciliation may move the watch to a newer head before checks are applied. */
    async reconcilePr(
        handle: string,
        info: PrInfo,
        expectedSha?: string,
        expectedRevision?: number,
    ): Promise<void> {
        const entry = this.watches.get(handle);
        if (
            !entry ||
            entry.status.state !== "pending" ||
            (expectedSha !== undefined && entry.status.sha !== expectedSha) ||
            (expectedRevision !== undefined && entry.revision !== expectedRevision)
        )
            return;
        if (info.merged) {
            this.settle(entry, "completed", "pr_merged");
            return;
        }
        if (info.state === "closed") {
            this.settle(entry, "completed", "pr_closed");
            return;
        }
        if (info.sha !== entry.status.sha) {
            if (entry.status.mode === "feedback") {
                entry.status.sha = info.sha;
                entry.status.updatedAt = Date.now();
            } else {
                await this.moveToSha(entry, info.sha);
            }
        }
    }

    getPollSnapshot(
        handle: string,
    ): { sha: string; revision: number; feedbackRevision: number } | null {
        const entry = this.watches.get(handle);
        if (!entry || entry.status.state !== "pending") return null;
        return {
            sha: entry.status.sha,
            revision: entry.revision,
            feedbackRevision: entry.feedbackRevision,
        };
    }

    applyPolledChecks(
        handle: string,
        fresh: CheckInfo[],
        expectedSha?: string,
        expectedRevision?: number,
    ): boolean {
        const entry = this.watches.get(handle);
        if (
            !entry ||
            entry.status.state !== "pending" ||
            (expectedSha !== undefined && entry.status.sha !== expectedSha) ||
            (expectedRevision !== undefined && entry.revision !== expectedRevision)
        )
            return false;
        const before = entry.status.state;
        this.applyChecks(entry, fresh, expectedRevision ?? entry.revision);
        return before !== entry.status.state;
    }

    applyPolledFeedback(handle: string, items: FeedbackItem[], expectedRevision?: number): boolean {
        const entry = this.watches.get(handle);
        if (
            !entry ||
            entry.status.state !== "pending" ||
            (entry.status.mode !== "feedback" && entry.status.mode !== "both") ||
            !entry.feedbackBaselineReady ||
            (expectedRevision !== undefined && entry.feedbackRevision !== expectedRevision)
        )
            return false;
        let changed = false;
        for (const item of items) {
            const baseline = entry.feedbackBaseline.get(item.id);
            const changedSinceBaseline =
                baseline !== undefined && baseline !== this.feedbackFingerprint(item);
            if (baseline === undefined || changedSinceBaseline) {
                changed = this.recordFeedback(entry, item) || changed;
            }
        }
        if (changed) this.updateFeedbackList(entry);
        return changed;
    }

    recordPollError(handle: string, error: unknown): void {
        const entry = this.watches.get(handle);
        if (!entry || entry.status.state !== "pending") return;
        entry.status.lastPollError = error instanceof Error ? error.message : String(error);
        entry.status.updatedAt = Date.now();
    }
    allHandles(): string[] {
        return [...this.watches.keys()];
    }
}
