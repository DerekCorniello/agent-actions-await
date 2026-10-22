import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { createHttpServer } from "../src/http-server.js";
import { FallbackPoller } from "../src/poller.js";

function sig(secret: string, body: Buffer): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("e2e http+bus+watch", () => {
    it("watch pending then webhook arrives via http and watch completes", async () => {
        const SECRET = "e".repeat(64);
        const bus = new EventBus();
        const getPrInfo = vi.fn(async () => ({
            sha: "e2e-sha",
            state: "open" as const,
            merged: false,
        }));
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce([
                { name: "ci", status: "in_progress", conclusion: null, sha: "e2e-sha" },
            ])
            .mockResolvedValue([
                { name: "ci", status: "completed", conclusion: "success", sha: "e2e-sha" },
            ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: getPrInfo,
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000, graceMs: 0, settleMs: 1 },
        );

        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 99 });
        expect((wm.getStatus(handle) as { state: string }).state).toBe("pending");

        const { server, url } = await createHttpServer({
            bus,
            getSecret: (o, r) => (o === "acme" && r === "demo" ? SECRET : undefined),
            port: 0,
        });
        const payload = {
            repository: { owner: { login: "acme" }, name: "demo" },
            check_run: {
                head_sha: "e2e-sha",
                status: "completed",
                conclusion: "success",
                name: "ci",
            },
        };
        const body = Buffer.from(JSON.stringify(payload));
        const res = await fetch(`${url}/webhook`, {
            method: "POST",
            headers: {
                "X-GitHub-Event": "check_run",
                "X-Hub-Signature-256": sig(SECRET, body),
                "X-GitHub-Delivery": "e2e-1",
                "content-type": "application/json",
            },
            body,
        });
        expect(res.status).toBe(200);
        await vi.waitFor(() => expect(getPrInfo).toHaveBeenCalledTimes(2), { timeout: 1000 });
        await vi.waitFor(() => expect(wm.getStatus(handle)).toMatchObject({ state: "completed" }), {
            timeout: 1000,
        });
        const st = wm.getStatus(handle) as { state: string };
        // may be completed or timed_out already consumed? First read after webhook should be completed
        expect(st.state).toBe("completed");
        server.close();
    });

    it("poll fallback completes pending watch when webhook never arrives", async () => {
        const bus = new EventBus();
        const getPrInfo = vi.fn(async () => ({
            sha: "poll-sha",
            state: "open" as const,
            merged: false,
        }));
        const getChecks = vi
            .fn()
            .mockResolvedValueOnce([
                { name: "ci", status: "in_progress", conclusion: null, sha: "poll-sha" },
            ])
            .mockResolvedValue([
                { name: "ci", status: "completed", conclusion: "success", sha: "poll-sha" },
            ]);
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: getPrInfo,
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000, graceMs: 0, settleMs: 1 },
        );
        const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 100 });
        await vi.waitFor(() => expect(getChecks).toHaveBeenCalledTimes(1));

        const pollFetch = vi.fn(async (url: string) => {
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
            fetchFn: pollFetch as unknown as typeof fetch,
            getPrInfoFn: getPrInfo as unknown as typeof import("../src/github.js").getPrInfo,
            intervalMs: 1000,
            graceMs: 0,
        });
        await poller.pollOnce();
        await vi.waitFor(() => expect(wm.getStatus(handle)).toMatchObject({ state: "completed" }), {
            timeout: 1000,
        });
        const st = wm.getStatus(handle) as { state: string };
        expect(st.state).toBe("completed");
        expect(getChecks).toHaveBeenCalledTimes(2);
    });

    it("1MB+1 payload is rejected 413 and does not publish", async () => {
        const SECRET = "f".repeat(64);
        const bus = new EventBus();
        let fired = false;
        bus.subscribeAll(() => (fired = true));
        const { server, url } = await createHttpServer({
            bus,
            getSecret: () => SECRET,
            port: 0,
            maxBytes: 1_000_000,
        });
        const big = Buffer.alloc(1_000_001, 0x61);
        const res = await fetch(`${url}/webhook`, {
            method: "POST",
            headers: {
                "X-GitHub-Event": "check_run",
                "X-Hub-Signature-256": sig(SECRET, big),
                "X-GitHub-Delivery": "big-1",
                "content-type": "application/json",
            },
            body: big,
        });
        expect(res.status).toBe(413);
        expect(fired).toBe(false);
        server.close();
    });
});
