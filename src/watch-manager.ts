import { randomUUID } from "node:crypto";
import type { EventBus, NormalizedEvent } from "./bus.js";
import {
  getPrHeadSha,
  getChecksForShaWithGrace,
  filterChecks,
  allSettled,
  summarize,
  type CheckInfo,
  type CheckFilter,
  type FetchFn,
  type GhAuth,
} from "./github.js";

export type WatchStatus = {
  handle: string;
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
  filter: CheckFilter;
  state: "pending" | "completed" | "timed_out";
  checks: CheckInfo[];
  pending: CheckInfo[];
  completed: CheckInfo[];
  createdAt: number;
  updatedAt: number;
};

export type WatchEntry = {
  status: WatchStatus;
  unsub: () => void;
  timer?: NodeJS.Timeout;
  consumedAfterSettled: boolean;
  gcTimer?: NodeJS.Timeout;
};

export type WatchManagerOpts = {
  defaultTimeoutMs?: number;
  graceMs?: number;
  pollIntervalMs?: number;
  gcAfterMs?: number; // after first read of settled, GC (Q37 5m variant)
};

export class WatchManager {
  private readonly watches = new Map<string, WatchEntry>();
  // dedup key -> handle
  private readonly dedup = new Map<string, string>();
  private readonly bus: EventBus;
  private readonly getPrHeadShaFn: typeof getPrHeadSha;
  private readonly getChecksFn: typeof getChecksForShaWithGrace;
  private readonly opts: Required<WatchManagerOpts>;

  constructor(
    bus: EventBus,
    deps?: { getPrHeadShaFn?: typeof getPrHeadSha; getChecksFn?: typeof getChecksForShaWithGrace },
    opts?: WatchManagerOpts,
  ) {
    this.bus = bus;
    this.getPrHeadShaFn = deps?.getPrHeadShaFn ?? getPrHeadSha;
    this.getChecksFn = deps?.getChecksFn ?? getChecksForShaWithGrace;
    this.opts = {
      defaultTimeoutMs: opts?.defaultTimeoutMs ?? 600_000, // Q20 default 600s
      graceMs: opts?.graceMs ?? 60_000,
      pollIntervalMs: opts?.pollIntervalMs ?? 2000,
      gcAfterMs: opts?.gcAfterMs ?? 5 * 60 * 1000,
    };
  }

  private dedupKey(owner: string, repo: string, sha: string, filter: CheckFilter): string {
    const f = Array.isArray(filter) ? [...filter].sort().join(",") : String(filter);
    return `${owner}/${repo}@${sha}|${f}`;
  }

  private makeHandle(): string {
    return randomUUID();
  }

  async startWatch(args: {
    owner: string;
    repo: string;
    prNumber: number;
    filter?: CheckFilter | undefined;
    timeoutMs?: number | undefined;
    auth?: GhAuth | undefined;
    fetchFn?: FetchFn | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  }): Promise<string> {
    const filter: CheckFilter = args.filter ?? "all";
    const timeoutMs = args.timeoutMs ?? this.opts.defaultTimeoutMs;

    // Resolve head SHA (fork-safe: baseOwner/baseRepo@sha)
    const sha = await this.getPrHeadShaFn({
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      auth: args.auth,
      fetchFn: args.fetchFn,
      env: args.env,
    });

    const dKey = this.dedupKey(args.owner, args.repo, sha, filter);
    const existing = this.dedup.get(dKey);
    if (existing) {
      const e = this.watches.get(existing);
      if (e) return existing;
      // stale dedup
      this.dedup.delete(dKey);
    }

    const checks = await this.getChecksFn({
      owner: args.owner,
      repo: args.repo,
      sha,
      auth: args.auth,
      fetchFn: args.fetchFn,
      env: args.env,
      graceMs: this.opts.graceMs,
      pollIntervalMs: this.opts.pollIntervalMs,
    });

    const filtered = filterChecks(checks, filter);
    const { pending, completed } = summarize(filtered);
    const isDone = filtered.length > 0 && allSettled(filtered);

    const handle = this.makeHandle();
    const now = Date.now();
    const status: WatchStatus = {
      handle,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      sha,
      filter,
      state: isDone ? "completed" : "pending",
      checks: filtered,
      pending,
      completed,
      createdAt: now,
      updatedAt: now,
    };

    // If already completed, store but mark for GC after first read (Q37)
    if (isDone) {
      this.watches.set(handle, {
        status,
        unsub: () => {},
        consumedAfterSettled: false,
      });
      this.dedup.set(dKey, handle);
      return handle;
    }

    // Pending: subscribe to bus for this sha
    const entry: WatchEntry = {
      status,
      unsub: () => {},
      consumedAfterSettled: false,
    };
    // Timeout -> structured timed_out with partial results (Q20)
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const e = this.watches.get(handle);
        if (!e) return;
        if (e.status.state === "pending") {
          e.status.state = "timed_out";
          e.status.updatedAt = Date.now();
          e.unsub();
        }
      }, timeoutMs);
      entry.timer.unref?.();
    }

    const onEvent = (evt: NormalizedEvent) => {
      const e = this.watches.get(handle);
      if (!e || e.status.state !== "pending") return;

      // Only handle events matching filter (exact name) if not 'all'
      if (filter !== "all") {
        const wanted = new Set(Array.isArray(filter) ? filter : [filter]);
        if (!wanted.has(evt.name)) return;
      }

      // Update or add check entry based on event
      const idx = e.status.checks.findIndex((c) => c.name === evt.name);
      const updated: CheckInfo = {
        name: evt.name,
        status: evt.status,
        conclusion: evt.conclusion,
        sha: evt.sha,
      };
      if (idx >= 0) {
        e.status.checks[idx] = updated;
      } else {
        e.status.checks.push(updated);
      }
      const summ = summarize(e.status.checks);
      e.status.pending = summ.pending;
      e.status.completed = summ.completed;
      e.status.updatedAt = Date.now();

      // Handle PR head move (Q15 reset): pull_request event with new sha
      if (evt.type === "pull_request" && evt.sha !== e.status.sha) {
        // Reset: new SHA, refetch baseline for new sha asynchronously
        e.status.sha = evt.sha;
        e.status.state = "pending";
        e.status.checks = [];
        e.status.pending = [];
        e.status.completed = [];
        // Swap bus subscription to new sha
        e.unsub();
        e.unsub = this.bus.subscribe(e.status.owner, e.status.repo, evt.sha, onEvent);
        // Refetch checks for new sha with grace
        void this.getChecksFn({
          owner: e.status.owner,
          repo: e.status.repo,
          sha: evt.sha,
          auth: args.auth,
          fetchFn: args.fetchFn,
          env: args.env,
          graceMs: this.opts.graceMs,
          pollIntervalMs: this.opts.pollIntervalMs,
        }).then((newChecks) => {
          const ee = this.watches.get(handle);
          if (!ee || ee.status.state !== "pending") return;
          ee.status.checks = filterChecks(newChecks, filter);
          const s = summarize(ee.status.checks);
          ee.status.pending = s.pending;
          ee.status.completed = s.completed;
          ee.status.updatedAt = Date.now();
          if (ee.status.checks.length > 0 && allSettled(ee.status.checks)) {
            ee.status.state = "completed";
            ee.unsub();
            if (ee.timer) clearTimeout(ee.timer);
          }
        });
        return;
      }

      // Closed/merged PR handling (Q15 fail-fast): check if event type pull_request with closed/merged
      if (evt.type === "pull_request" && (evt.status === "closed" || evt.status === "merged")) {
        e.status.state = "completed";
        e.unsub();
        if (e.timer) clearTimeout(e.timer);
        return;
      }

      if (e.status.checks.length > 0 && allSettled(e.status.checks)) {
        e.status.state = "completed";
        e.unsub();
        if (e.timer) clearTimeout(e.timer);
      }
    };

    entry.unsub = this.bus.subscribe(args.owner, args.repo, sha, onEvent);
    // Also subscribe to pull_request events for same base repo but any sha to catch head moves.
    // We need wildcard for pull_request on base repo; simplest: subscribeAll and filter to this PR.
    // For production-like but lightweight, we poll PR sha periodically? Instead we subscribeAll for PR moves.
    // Add secondary subscription for pull_request events via subscribeAll if head moves via different sha key:
    // Our bus is keyed by sha, so pull_request for new sha won't hit old key. So we subscribeAll to catch any pull_request for this base.
    const allUnsub = this.bus.subscribeAll((evt) => {
      if (evt.type !== "pull_request") return;
      if (evt.owner !== args.owner || evt.repo !== args.repo) return;
      // Only if event's PR number matches? But NormalizedEvent for pull_request encodes name as pr:<number>.
      // Check if this is the same PR number.
      if (evt.name !== `pr:${args.prNumber}`) return;
      onEvent(evt);
    });
    const origUnsub = entry.unsub;
    entry.unsub = () => {
      origUnsub();
      allUnsub();
    };

    this.watches.set(handle, entry);
    this.dedup.set(dKey, handle);
    return handle;
  }

  getStatus(handle: string): WatchStatus | { error: string; hint?: string } {
    const e = this.watches.get(handle);
    if (!e) return { error: "handle_not_found", hint: "watch already completed and GC'd or unknown handle" };
    // If settled and already consumed once, GC on this read (Q37 keep briefly until first read)
    if ((e.status.state === "completed" || e.status.state === "timed_out") && e.consumedAfterSettled) {
      this.watches.delete(handle);
      // also clean dedup
      for (const [k, v] of this.dedup) if (v === handle) this.dedup.delete(k);
      return { error: "handle_not_found", hint: "watch already completed and GC'd or unknown handle" };
    }
    const snap = { ...e.status, checks: [...e.status.checks], pending: [...e.status.pending], completed: [...e.status.completed] };
    if (e.status.state === "completed" || e.status.state === "timed_out") {
      if (!e.consumedAfterSettled) {
        e.consumedAfterSettled = true;
        // schedule hard GC after gcAfterMs even if never read again
        e.gcTimer = setTimeout(() => {
          this.watches.delete(handle);
          for (const [k, v] of this.dedup) if (v === handle) this.dedup.delete(k);
        }, this.opts.gcAfterMs);
        e.gcTimer.unref?.();
      }
    }
    return snap;
  }

  close(handle: string): boolean {
    const e = this.watches.get(handle);
    if (!e) return false;
    e.unsub();
    if (e.timer) clearTimeout(e.timer);
    if (e.gcTimer) clearTimeout(e.gcTimer);
    this.watches.delete(handle);
    for (const [k, v] of this.dedup) if (v === handle) this.dedup.delete(k);
    return true;
  }

  /**
   * Blocking await: startWatch + wait until settled/timeout.
   * If notify callback provided, it is invoked per bus event (best-effort Q19).
   */
  async awaitWatch(
    args: {
      owner: string;
      repo: string;
      prNumber: number;
      filter?: CheckFilter;
      timeoutMs?: number;
      auth?: GhAuth | undefined;
      fetchFn?: FetchFn;
      env?: NodeJS.ProcessEnv;
    },
    notify?: (evt: NormalizedEvent) => void,
  ): Promise<WatchStatus> {
    const handle = await this.startWatch(args);
    // peek without marking consumed
    const peek = (): WatchStatus | null => {
      const e = this.watches.get(handle);
      if (!e) return null;
      return { ...e.status, checks: [...e.status.checks], pending: [...e.status.pending], completed: [...e.status.completed] };
    };
    const initial = peek();
    if (!initial) throw new Error("handle_not_found");
    if (initial.state !== "pending") {
      // mark consumed for handle+poll GC contract but return immediately for await
      const e = this.watches.get(handle);
      if (e && !e.consumedAfterSettled) {
        e.consumedAfterSettled = true;
        e.gcTimer = setTimeout(() => {
          this.watches.delete(handle);
          for (const [k, v] of this.dedup) if (v === handle) this.dedup.delete(k);
        }, this.opts.gcAfterMs);
        e.gcTimer.unref?.();
      }
      return initial;
    }

    return new Promise((resolve) => {
      let notifyUnsub: (() => void) | undefined;
      if (notify) {
        notifyUnsub = this.bus.subscribeAll((e) => {
          if (e.owner !== args.owner || e.repo !== args.repo) return;
          const f = args.filter ?? "all";
          if (f !== "all") {
            const wanted = new Set(Array.isArray(f) ? f : [f]);
            if (!wanted.has(e.name)) return;
          }
          notify(e);
        });
      }

      const finish = (snap: WatchStatus) => {
        if (notifyUnsub) notifyUnsub();
        if (unsubAll) unsubAll();
        if (interval) clearInterval(interval);
        // mark GC
        const e = this.watches.get(handle);
        if (e && !e.consumedAfterSettled) {
          e.consumedAfterSettled = true;
          e.gcTimer = setTimeout(() => {
            this.watches.delete(handle);
            for (const [k, v] of this.dedup) if (v === handle) this.dedup.delete(k);
          }, this.opts.gcAfterMs);
          e.gcTimer.unref?.();
        }
        resolve(snap);
      };

      const unsubAll = this.bus.subscribeAll(() => {
        const s = peek();
        if (!s) {
          finish(initial);
          return;
        }
        if (s.state !== "pending") finish(s);
      });

      // Poll for timeout-driven state change (entry.timer doesn't emit bus event)
      const interval = setInterval(() => {
        const s = peek();
        if (s && s.state !== "pending") finish(s);
      }, 10);
      interval.unref?.();
    });
  }

  handleCount(): number {
    return this.watches.size;
  }
}
