import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { FallbackPoller } from "../src/poller.js";

describe("FallbackPoller", () => {
    it("pollOnce fetches checks and completes pending watch (fallback safety net Q12)", async () => {
        const bus = new EventBus();
        const getPrHeadSha = vi.fn(async () => "sha1");
        const getChecks = vi.fn(async () => [
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha1" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
        expect((wm.getStatus(handle) as { state: string }).state).toBe("pending");

        // Now poller fetches fresh completed
        const freshFetch = vi.fn(async (url: string) => {
            if (url.includes("check-runs"))
                return new Response(
                    JSON.stringify({
                        check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            return new Response(JSON.stringify({ statuses: [], state: "success" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const poller = new FallbackPoller(wm, {
            fetchFn: freshFetch as unknown as typeof fetch,
            intervalMs: 1000,
            graceMs: 0,
        });
        await poller.pollOnce();
        const st = wm.getStatus(handle) as { state: string };
        // first read after poll will be completed; second read GC
        expect(st.state).toBe("completed");
    });

    it("pollOnce with empty checks does not mark completed (Q21)", async () => {
        const bus = new EventBus();
        const getPrHeadSha = vi.fn(async () => "sha1");
        const getChecks = vi.fn(async () => [
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha1" },
        ]);
        const wm = new WatchManager(
            bus,
            {
                getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
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
            intervalMs: 1000,
            graceMs: 0,
        });
        await poller.pollOnce();
        expect((wm.getStatus(handle) as { state: string }).state).toBe("pending");
    });

    it("start/stop scheduling does not throw", async () => {
        const bus = new EventBus();
        const getPrHeadSha2 = vi.fn(async () => "sha1");
        const getChecks2 = vi.fn(async () => []);
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha2 as unknown as typeof getPrHeadSha2,
            getChecksFn: getChecks2 as unknown as typeof getChecks2,
        });
        const poller = new FallbackPoller(wm, { intervalMs: 50, graceMs: 10 });
        poller.start();
        await new Promise((r) => setTimeout(r, 30));
        poller.stop();
        expect(true).toBe(true);
    });
});
