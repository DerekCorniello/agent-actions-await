import { describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { createMcpServer } from "../src/mcp-server.js";

function makeWatchHelpers(sha = "sha-mcp", status: "in_progress" | "completed" = "in_progress") {
    const getPrHeadSha = vi.fn(async () => sha);
    const getChecks = vi.fn(async () => [
        { name: "ci", status, conclusion: status === "completed" ? "success" : null, sha },
    ]);
    return { getPrHeadSha, getChecks };
}

async function linkedClient(bus: EventBus, wm: WatchManager) {
    const server = createMcpServer({ bus, watchManager: wm });
    const client = new Client({ name: "test-client", version: "1.0" }, { capabilities: {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
}

describe("mcp-server", () => {
    it("lists three tools", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers();
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const { client } = await linkedClient(bus, wm);
        const res = await client.listTools();
        expect(res.tools.map((t) => t.name).sort()).toEqual([
            "await_pr_actions",
            "get_pr_watch_status",
            "start_pr_watch",
        ]);
    });

    it("start_pr_watch returns handle and get_pr_watch_status reflects pending/completed", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers("sha1", "in_progress");
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const { client } = await linkedClient(bus, wm);

        const start = await client.callTool({
            name: "start_pr_watch",
            arguments: { owner: "acme", repo: "demo", pr_number: 1 },
        });
        const txt = (start.content as Array<{ text: string }>)[0]!.text;
        const { handle } = JSON.parse(txt) as { handle: string };
        expect(handle).toMatch(/^[0-9a-f-]{36}$/);

        const pending = await client.callTool({
            name: "get_pr_watch_status",
            arguments: { handle },
        });
        const ptxt = (pending.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(ptxt).state).toBe("pending");

        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        });
        await new Promise((r) => setTimeout(r, 20));

        const done = await client.callTool({ name: "get_pr_watch_status", arguments: { handle } });
        const dtxt = (done.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(dtxt).state).toBe("completed");
    });

    it("get_pr_watch_status returns handle_not_found after first read of completed (Q37)", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers("sha2", "completed");
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const { client } = await linkedClient(bus, wm);
        const start = await client.callTool({
            name: "start_pr_watch",
            arguments: { owner: "acme", repo: "demo", pr_number: 2 },
        });
        const handle = (
            JSON.parse((start.content as Array<{ text: string }>)[0]!.text) as { handle: string }
        ).handle;
        await client.callTool({ name: "get_pr_watch_status", arguments: { handle } });
        const second = await client.callTool({
            name: "get_pr_watch_status",
            arguments: { handle },
        });
        const stxt = (second.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(stxt).error).toBe("handle_not_found");
    });

    it("invalid arguments return isError with zod message", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers();
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const { client } = await linkedClient(bus, wm);
        const res = await client.callTool({
            name: "start_pr_watch",
            arguments: { owner: "", repo: "demo", pr_number: -1 },
        });
        expect(res.isError).toBe(true);
        const txt = (res.content as Array<{ text: string }>)[0]!.text;
        expect(txt).toMatch(/error/i);
    });

    it("unknown tool returns isError", async () => {
        const bus = new EventBus();
        const fakeHead = vi.fn(
            async () => "s",
        ) as unknown as typeof import("../src/github.js").getPrHeadSha;
        const fakeChecks = vi.fn(
            async () => [],
        ) as unknown as typeof import("../src/github.js").getChecksForShaWithGrace;
        const wm = new WatchManager(bus, { getPrHeadShaFn: fakeHead, getChecksFn: fakeChecks });
        const { client } = await linkedClient(bus, wm);
        const res = await client.callTool({ name: "nope", arguments: {} });
        expect(res.isError).toBe(true);
    });

    it("await_pr_actions blocks until webhook completes and sends progress", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers("sha-await", "in_progress");
        const wm = new WatchManager(
            bus,
            {
                getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 5000 },
        );
        const { client } = await linkedClient(bus, wm);
        const p = client.callTool({
            name: "await_pr_actions",
            arguments: { owner: "acme", repo: "demo", pr_number: 3, timeout_seconds: 2 },
        });
        setTimeout(
            () =>
                bus.publish({
                    owner: "acme",
                    repo: "demo",
                    sha: "sha-await",
                    type: "check_run",
                    status: "completed",
                    conclusion: "success",
                    name: "ci",
                }),
            20,
        );
        const res = await p;
        const txt = (res.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(txt).state).toBe("completed");
    });

    it("await_pr_actions times out to timed_out", async () => {
        const bus = new EventBus();
        const { getPrHeadSha, getChecks } = makeWatchHelpers("sha-to", "in_progress");
        const wm = new WatchManager(
            bus,
            {
                getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
                getChecksFn: getChecks as unknown as typeof getChecks,
            },
            { defaultTimeoutMs: 1000 },
        );
        const { client } = await linkedClient(bus, wm);
        const res = await client.callTool({
            name: "await_pr_actions",
            arguments: { owner: "acme", repo: "demo", pr_number: 4, timeout_seconds: 1 },
        });
        const txt = (res.content as Array<{ text: string }>)[0]!.text;
        expect(JSON.parse(txt).state).toBe("timed_out");
    });

    it("filter exact match: only wanted check completes", async () => {
        const bus = new EventBus();
        const getPrHeadSha = vi.fn(async () => "sha-f");
        const getChecks = vi.fn(async () => [
            { name: "ci", status: "in_progress", conclusion: null, sha: "sha-f" },
            { name: "lint", status: "in_progress", conclusion: null, sha: "sha-f" },
        ]);
        const wm = new WatchManager(bus, {
            getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha,
            getChecksFn: getChecks as unknown as typeof getChecks,
        });
        const { client } = await linkedClient(bus, wm);
        const start = await client.callTool({
            name: "start_pr_watch",
            arguments: { owner: "acme", repo: "demo", pr_number: 5, filter: "ci" },
        });
        const handle = (
            JSON.parse((start.content as Array<{ text: string }>)[0]!.text) as { handle: string }
        ).handle;
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha-f",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "lint",
        });
        await new Promise((r) => setTimeout(r, 15));
        let txt1 = (await client
            .callTool({ name: "get_pr_watch_status", arguments: { handle } })
            .then((r) => (r.content as Array<{ text: string }>)[0]!.text)) as string;
        let st = (JSON.parse(txt1) as { state: string }).state;
        expect(st).toBe("pending");
        bus.publish({
            owner: "acme",
            repo: "demo",
            sha: "sha-f",
            type: "check_run",
            status: "completed",
            conclusion: "success",
            name: "ci",
        });
        await new Promise((r) => setTimeout(r, 15));
        const txt2 = (await client
            .callTool({ name: "get_pr_watch_status", arguments: { handle } })
            .then((r) => (r.content as Array<{ text: string }>)[0]!.text)) as string;
        st = (JSON.parse(txt2) as { state: string }).state;
        expect(st).toBe("completed");
    });
});
