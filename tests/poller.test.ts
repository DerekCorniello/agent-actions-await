import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { FallbackPoller } from "../src/poller.js";
import type { CheckInfo, PrInfo } from "../src/github.js";
import type { FeedbackItem } from "../src/feedback.js";

describe("FallbackPoller", () => {
    it("polls feedback-only watches without querying PR checks or heads", async () => {
        const bus = new EventBus();
        const past = new Date(Date.now() - 60_000).toISOString();
        const old: FeedbackItem = {
            id: "review:old",
            kind: "review",
            author: "bot",
            body: "old",
            url: "https://example.test/old",
            createdAt: past,
            updatedAt: past,
        };
        const releasedDraft: FeedbackItem = {
            id: "review_comment:new",
            kind: "review_comment",
            author: "bot",
            body: "new inline comment",
            url: "https://example.test/new",
            createdAt: past,
            updatedAt: past,
        };
        const getPrFeedbackFn = vi
            .fn()
            .mockResolvedValueOnce([old])
            .mockResolvedValueOnce([old, releasedDraft]);
        const getPrInfoFn = vi.fn(async () => ({
            sha: "sha1",
            state: "open" as const,
            merged: false,
        }));
        const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
        const wm = new WatchManager(bus, { getPrInfoFn, getPrFeedbackFn }, { feedbackQuietMs: 0 });
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 5,
            mode: "feedback",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        getPrInfoFn.mockClear();
        const poller = new FallbackPoller(wm, { getPrInfoFn, getPrFeedbackFn, fetchFn });
        await poller.pollOnce();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("completed");
        expect(status.feedback.map((item) => item.id)).toEqual(["review_comment:new"]);
        expect(getPrInfoFn).toHaveBeenCalledTimes(1);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("reconciles closure for feedback-only watches without requesting checks", async () => {
        const bus = new EventBus();
        let prInfo: PrInfo = { sha: "sha1", state: "open", merged: false };
        const getPrInfoFn = vi.fn(async () => prInfo);
        const getChecksFn = vi.fn(async () => []);
        const getPrFeedbackFn = vi.fn(async (): Promise<FeedbackItem[]> => []);
        const wm = new WatchManager(bus, {
            getPrInfoFn,
            getChecksFn: getChecksFn as never,
            getPrFeedbackFn,
        });
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 6,
            mode: "feedback",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        prInfo = { sha: "sha1", state: "closed", merged: false };
        const poller = new FallbackPoller(wm, { getPrInfoFn, getPrFeedbackFn });
        await poller.pollOnce();
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("completed");
        expect(status.completionReason).toBe("pr_closed");
        expect(getChecksFn).not.toHaveBeenCalled();
    });
    it("pollOnce fetches checks and completes pending watch (fallback safety net Q12)", async () => {
        const bus = new EventBus();
        const getChecks = vi.fn(async (): Promise<CheckInfo[]> => [
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha1" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000, settleMs: 0 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        expect((wm.getStatus(handle) as { state: string }).state).toBe("pending");

        // Now poller fetches fresh completed
        const freshFetch = vi.fn(async (url: string) => {
            if (url.includes("check-runs")) {
                getChecks.mockResolvedValue([
                    { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
                ]);
                return new Response(
                    JSON.stringify({
                        check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            return new Response(JSON.stringify({ statuses: [], state: "success" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const poller = new FallbackPoller(wm, {
            fetchFn: freshFetch as unknown as typeof fetch,
            getPrInfoFn: vi.fn(async () => ({
                sha: "sha1",
                state: "open" as const,
                merged: false,
            })),
            intervalMs: 1000,
            graceMs: 0,
        });
        await poller.pollOnce();
        await new Promise((resolve) => setTimeout(resolve, 1));
        const st = wm.getStatus(handle) as { state: string };
        // first read after poll will be completed; second read GC
        expect(st.state).toBe("completed");
    });

    it("pollOnce with empty checks does not mark completed (Q21)", async () => {
        const bus = new EventBus();
        const getChecks = vi.fn(async () => [
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha1" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        const emptyFetch = vi.fn(async (url: string) => {
            if (url.includes("check-runs"))
                return new Response(JSON.stringify({ check_runs: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            return new Response(JSON.stringify({ statuses: [], state: "pending" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const poller = new FallbackPoller(wm, {
            fetchFn: emptyFetch as unknown as typeof fetch,
            getPrInfoFn: vi.fn(async () => ({
                sha: "sha1",
                state: "open" as const,
                merged: false,
            })),
            intervalMs: 1000,
            graceMs: 0,
        });
        await poller.pollOnce();
        expect((wm.getStatus(handle) as { state: string }).state).toBe("pending");
    });

    it("reconciles a changed head, ignores stale snapshots, and reports closed PR reason", async () => {
        const bus = new EventBus();
        let prInfo: PrInfo = { sha: "sha1", state: "open", merged: false };
        const getChecks = vi.fn(async ({ sha }: { sha: string }): Promise<CheckInfo[]> => [
            { name: "ci", status: "in_progress", conclusion: null, sha },
        ]);
        const wm = new WatchManager(bus, {
            getPrInfoFn: async () => prInfo,
            getChecksFn: getChecks as never,
        });
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 4 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const fetchFn = vi.fn(async (url: string) => {
            if (url.includes("check-runs"))
                return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
            return new Response(JSON.stringify({ statuses: [], state: "pending" }), {
                status: 200,
            });
        });
        const poller = new FallbackPoller(wm, {
            fetchFn: fetchFn as unknown as typeof fetch,
            getPrInfoFn: async () => prInfo,
        });
        prInfo = { sha: "sha2", state: "open", merged: false };
        await poller.pollOnce();
        const moved = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(moved.sha).toBe("sha2");
        prInfo = { sha: "sha2", state: "closed", merged: false };
        await poller.pollOnce();
        const closed = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(closed.state).toBe("completed");
        expect(closed.completionReason).toBe("pr_closed");
    });

    it("start/stop scheduling does not throw", async () => {
        const bus = new EventBus();
        const getChecks2 = vi.fn(async () => []);
        const wm = new WatchManager(bus, {
            getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
            getChecksFn: getChecks2 as unknown as typeof getChecks2,
        });
        const poller = new FallbackPoller(wm, { intervalMs: 50, graceMs: 10 });
        poller.start();
        await new Promise((r) => setTimeout(r, 30));
        poller.stop();
        expect(true).toBe(true);
    });
});
