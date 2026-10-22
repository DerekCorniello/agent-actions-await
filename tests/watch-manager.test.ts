import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import type { NormalizedEvent } from "../src/bus.js";
import type { CheckInfo } from "../src/github.js";
import type { FeedbackItem } from "../src/feedback.js";

function makeFeedback(
    id: string,
    author = "bot",
    body = "reviewed",
    date = new Date(Date.now() + 1000).toISOString(),
): FeedbackItem {
    return {
        id,
        kind: "issue_comment",
        author,
        body,
        url: `https://example.test/${id}`,
        createdAt: date,
        updatedAt: date,
    };
}

function makeGhMocks(
    sha: string,
    checks: Array<{ name: string; status: string; conclusion: string | null }>,
) {
    const getPrHeadSha = vi.fn(async () => sha);
    const getChecks = vi.fn(async () => checks.map((c) => ({ ...c, sha })));
    return { getPrHeadSha, getChecks };
}

describe("WatchManager", () => {
    it("checks mode does not make feedback API calls", async () => {
        const getPrFeedbackFn = vi.fn(async () => []);
        const wm = new WatchManager(new EventBus(), {
            getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
            getPrFeedbackFn,
        });
        await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, mode: "checks" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getPrFeedbackFn).not.toHaveBeenCalled();
    });

    it("feedback mode excludes baseline items, filters authors, and completes after quiet time", async () => {
        const bus = new EventBus();
        const old = makeFeedback(
            "old",
            "teammate",
            "already there",
            new Date(Date.now() - 60_000).toISOString(),
        );
        const getPrFeedbackFn = vi.fn(async () => [old]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getPrFeedbackFn,
            },
            { feedbackQuietMs: 20 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 2,
            mode: "feedback",
            feedbackAuthors: ["BOT"],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const created = makeFeedback("new");
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 2,
            feedback: created,
        });
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 2,
            feedback: makeFeedback("ignored", "human"),
        });
        const pending = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(pending.state).toBe("pending");
        expect(pending.checksState).toBe("not_required");
        expect(pending.feedback.map((item) => item.id)).toEqual(["new"]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const done = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(done.state).toBe("completed");
        expect(done.completionReason).toBe("feedback_received");
    });

    it("keeps feedback from the watch start second when baseline fetch overlaps a webhook", async () => {
        const bus = new EventBus();
        let resolveBaseline!: (items: FeedbackItem[]) => void;
        const item = makeFeedback("during-baseline", "bot", "new item", new Date().toISOString());
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getPrFeedbackFn: () =>
                    new Promise((resolve) => {
                        resolveBaseline = resolve;
                    }),
            },
            { feedbackQuietMs: 5 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 20,
            mode: "feedback",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 20,
            feedback: item,
        });
        resolveBaseline([item]);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.feedback.map((feedback) => feedback.id)).toEqual(["during-baseline"]);
        expect(status.state).toBe("completed");
    });

    it("feedback-only watches survive head moves without fetching CI checks", async () => {
        const bus = new EventBus();
        const getChecksFn = vi.fn(async () => []);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: getChecksFn as never,
                getPrFeedbackFn: async () => [],
            },
            { feedbackQuietMs: 5 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 22,
            mode: "feedback",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "pull_request",
            status: "synchronize",
            conclusion: null,
            name: "pr:22",
        });
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 22,
            feedback: makeFeedback("review-after-push"),
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("completed");
        expect(status.sha).toBe("sha2");
        expect(getChecksFn).not.toHaveBeenCalled();
    });

    it("both mode completes on settled checks and retains feedback across head changes", async () => {
        const bus = new EventBus();
        let head = "sha1";
        let checksComplete = false;
        const getChecksFn = vi.fn(async ({ sha }: { sha: string }) => [
            {
                name: "ci",
                status: checksComplete ? "completed" : "in_progress",
                conclusion: checksComplete ? "success" : null,
                sha,
            },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: head, state: "open", merged: false }),
                getChecksFn: getChecksFn as never,
                getPrFeedbackFn: async () => [],
            },
            { feedbackQuietMs: 100, settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 3,
            mode: "both",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 3,
            feedback: makeFeedback("review-1"),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        let state = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(state.state).toBe("pending");
        expect(state.feedbackState).toBe("waiting");
        expect(state.checksState).toBe("waiting");
        head = "sha2";
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "pull_request",
            status: "synchronize",
            conclusion: null,
            name: "pr:3",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        checksComplete = true;
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(state.state).toBe("completed");
        expect(state.completionReason).toBe("checks_settled");
        expect(state.feedback.map((item) => item.id)).toEqual(["review-1"]);
        expect(state.feedbackState).toBe("waiting");
    });

    it("both mode completes on feedback while checks are still pending", async () => {
        const bus = new EventBus();
        const getChecksFn = vi.fn(async ({ sha }: { sha: string }) => [
            {
                name: "ci",
                status: "in_progress",
                conclusion: null,
                sha,
            },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: getChecksFn as never,
                getPrFeedbackFn: async () => [],
            },
            { feedbackQuietMs: 5, settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 23,
            mode: "both",
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "",
            type: "feedback",
            status: "submitted",
            conclusion: null,
            name: "feedback",
            prNumber: 23,
            feedback: makeFeedback("early-feedback"),
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("completed");
        expect(status.completionReason).toBe("feedback_received");
        expect(status.feedbackState).toBe("ready");
        expect(status.checksState).toBe("waiting");
    });
    it("returns a handle before head resolution and exposes failures", async () => {
        const bus = new EventBus();
        let rejectHead!: (error: Error) => void;
        const wm = new WatchManager(bus, {
            getPrInfoFn: () =>
                new Promise((_resolve, reject) => {
                    rejectHead = reject;
                }),
        });
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 9 });
        expect((wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus).state).toBe(
            "pending",
        );
        await new Promise((resolve) => setImmediate(resolve));
        rejectHead(new Error("GitHub unavailable"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("failed");
        expect(status.error).toContain("GitHub unavailable");
    });

    it("requires every named filter entry and keeps same-name checks distinct by ID", async () => {
        const bus = new EventBus();
        const getPrHeadSha = vi.fn(async () => "sha1");
        const getChecks = vi.fn(async () => [
            { name: "build", status: "completed", conclusion: "success", sha: "sha1", id: "run-1" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            filter: ["build", "test"],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "build",
            id: "run-2",
        } as NormalizedEvent);
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("pending");
        expect(status.checks).toHaveLength(2);
    });

    it("does not discard PR lifecycle events for a filtered check watch", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 7,
            filter: "ci",
        });
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "pull_request",
            status: "closed",
            conclusion: null,
            name: "pr:7",
        });
        expect((wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus).state).toBe(
            "completed",
        );
    });

    it("ignores a late initial head response after newer webhook heads", async () => {
        const bus = new EventBus();
        let resolveInitial!: (value: { sha: string; state: "open"; merged: false }) => void;
        const getPrInfoFn = vi.fn(
            () =>
                new Promise<{ sha: string; state: "open"; merged: false }>((resolve) => {
                    resolveInitial = resolve;
                }),
        );
        const getChecksFn = vi.fn(async ({ sha }: { sha: string }) => [
            { name: "ci", status: "in_progress", conclusion: null, sha },
        ]);
        const wm = new WatchManager(bus, { getPrInfoFn, getChecksFn: getChecksFn as never });
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 11 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "pull_request",
            status: "synchronize",
            conclusion: null,
            name: "pr:11",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha3",
            type: "pull_request",
            status: "synchronize",
            conclusion: null,
            name: "pr:11",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolveInitial({ sha: "sha1", state: "open", merged: false });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.sha).toBe("sha3");
        expect(status.checks[0]?.sha).toBe("sha3");
    });

    it("keeps a newer same-head webhook result over a stale baseline response", async () => {
        const bus = new EventBus();
        let resolveBaseline!: (checks: CheckInfo[]) => void;
        const getChecksFn = vi.fn(
            () =>
                new Promise<CheckInfo[]>((resolve) => {
                    resolveBaseline = resolve;
                }),
        );
        const wm = new WatchManager(bus, {
            getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
            getChecksFn: getChecksFn as never,
        });
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 14 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
            id: "run-1",
        } as NormalizedEvent);
        resolveBaseline([
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha1", id: "run-1" },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.checks[0]?.status).toBe("completed");
    });

    it("deduplicates only pending watches", async () => {
        const bus = new EventBus();
        let complete = true;
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: async () => [
                    {
                        name: "ci",
                        status: complete ? "completed" : "in_progress",
                        conclusion: complete ? "success" : null,
                        sha: "sha1",
                    },
                ],
            },
            { settleMs: 0 },
        );
        const first = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 12 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect((wm.getStatus(first) as import("../src/watch-manager.js").WatchStatus).state).toBe(
            "completed",
        );
        complete = false;
        const second = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 12 });
        expect(second).not.toBe(first);
    });

    it("completion confirmation discovers a late pending check", async () => {
        const bus = new EventBus();
        let fetchCount = 0;
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "sha1", state: "open", merged: false }),
                getChecksFn: async () => {
                    fetchCount++;
                    if (fetchCount === 1)
                        return [
                            { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
                        ];
                    return [
                        { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
                        { name: "security", status: "in_progress", conclusion: null, sha: "sha1" },
                    ];
                },
            },
            { settleMs: 0 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 13 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const status = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(status.state).toBe("pending");
        expect(status.pending.map((check) => check.name)).toContain("security");
    });

    it("startWatch immediately completes if all checks settled", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "completed", conclusion: "success" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000, settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            filter: "all",
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(st.state).toBe("completed");
        expect(st.completed).toHaveLength(1);
    });

    it("startWatch pending then completes on bus event", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000, settleMs: 0 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(st.state).toBe("pending");
        getChecks.mockResolvedValue([
            { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
        ]);
        getChecks.mockResolvedValue([
            { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
            { name: "lint", status: "completed", conclusion: "success", sha: "sha1" },
        ]);
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        } satisfies NormalizedEvent);
        // allow microtask
        await new Promise((r) => setTimeout(r, 600));
        st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("expected status");
        expect(st.state).toBe("completed");
    });

    it("dedups same sha+filter to same handle (Q27)", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { settleMs: 0 },
        );
        const h1 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "all" });
        const h2 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "all" });
        expect(h1).toBe(h2);
        expect(wm.handleCount()).toBe(1);
    });

    it("different filter gets different handle", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { settleMs: 0 },
        );
        const h1 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "ci" });
        const h2 = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            filter: "lint",
        });
        expect(h1).not.toBe(h2);
    });

    it("filter 'all' vs string: only wanted check drives completion", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
            { name: "lint", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { settleMs: 0 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            filter: "ci",
        });
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "lint",
        } as NormalizedEvent);
        await new Promise((r) => setTimeout(r, 600));
        let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("bad");
        expect(st.state).toBe("pending");
        getChecks.mockResolvedValue([
            { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
            { name: "lint", status: "completed", conclusion: "success", sha: "sha1" },
        ]);
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        } as NormalizedEvent);
        await new Promise((r) => setTimeout(r, 600));
        st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("bad");
        expect(st.state).toBe("completed");
    });

    it("times out with structured timed_out and partial results (Q20)", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 30 },
        );
        const handle = await wm.startWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            timeoutMs: 30,
        });
        await new Promise((r) => setTimeout(r, 60));
        const st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("expected timed_out status not GC'd");
        expect(st.state).toBe("timed_out");
        expect(st.pending).toHaveLength(1);
    });

    it("retains settled results across reads until TTL", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "completed", conclusion: "success" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { gcAfterMs: 10000, settleMs: 0 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const s1 = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(s1.state).toBe("completed");
        const s2 = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(s2.state).toBe("completed");
    });

    it("awaitWatch blocks and resolves on completion, with notifications (Q19 best-effort)", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000, settleMs: 0 },
        );
        const notes: string[] = [];
        const p = wm.awaitWatch({ owner: "acme", repo: "demo", prNumber: 1 }, (e) =>
            notes.push(e.name),
        );
        setTimeout(() => {
            getChecks.mockResolvedValue([
                { name: "ci", status: "completed", conclusion: "success", sha: "sha1" },
            ]);
            bus.publish({
                owner: "acme",
                repo: "demo",
                sha: "sha1",
                type: "check_run",
                status: "completed",
                conclusion: "success",
                name: "ci",
            } as NormalizedEvent);
        }, 20);
        const res = await p;
        expect(res.state).toBe("completed");
        expect(notes).toContain("ci");
    });

    it("awaitWatch times out returning timed_out (Q20)", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000, settleMs: 0 },
        );
        const res = await wm.awaitWatch({
            owner: "acme",
            repo: "demo",
            prNumber: 1,
            timeoutMs: 30,
        });
        expect(res.state).toBe("timed_out");
    });

    it("reset on new SHA via pull_request event (Q15) — new sha replaces watch", async () => {
        const bus = new EventBus();
        const sha1 = "sha1";
        const sha2 = "sha2";
        let currentSha = sha1;
        const getPrHeadSha = vi.fn(async () => currentSha);
        let checksComplete = false;
        const getChecks = vi.fn(async ({ sha }: { sha: string }) => [
            {
                name: "ci",
                status: checksComplete ? ("completed" as const) : ("in_progress" as const),
                conclusion: checksComplete ? "success" : null,
                sha,
            },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({
                    sha: await getPrHeadSha(),
                    state: "open" as const,
                    merged: false,
                }),
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000, settleMs: 0 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 42 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        expect(st.sha).toBe("sha1");
        // simulate force-push: PR head moves to sha2
        currentSha = sha2;
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "pull_request",
            status: "synchronize",
            conclusion: null,
            name: "pr:42",
        } as NormalizedEvent);
        await new Promise((r) => setTimeout(r, 30));
        st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("bad");
        expect(st.sha).toBe("sha2");
        // now complete new sha
        checksComplete = true;
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha2",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        } as NormalizedEvent);
        await new Promise((r) => setTimeout(r, 120));
        st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
        if ("error" in st) throw new Error("bad");
        expect(st.state).toBe("completed");
    });

    it("close removes watch and clears timer", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
            { name: "ci", status: "in_progress", conclusion: null },
        ]);
        const wm = new WatchManager(bus, {
            getPrInfoFn: async () => ({
                sha: await getPrHeadSha(),
                state: "open" as const,
                merged: false,
            }),
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const h = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        expect(wm.close(h)).toBe(true);
        expect((wm.getStatus(h) as { error: string }).error).toBe("handle_not_found");
        expect(wm.close(h)).toBe(false);
    });
});
