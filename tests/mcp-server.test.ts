import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { AGENT_INSTRUCTIONS, createMcpServer, parseWatchInput } from "../src/mcp-server.js";
import type { CheckInfo, PrInfo } from "../src/github.js";
import type { FeedbackItem } from "../src/feedback.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture() {
    const bus = new EventBus();
    let checks: CheckInfo[] = [
        { id: "check_run:1", name: "ci", status: "in_progress", conclusion: null, sha: "sha1" },
    ];
    const getPrInfo = vi.fn(async (): Promise<PrInfo> => ({
        sha: "sha1",
        state: "open" as const,
        merged: false,
    }));
    const getChecks = vi.fn(async () => checks);
    const getFeedback = vi.fn(async (): Promise<FeedbackItem[]> => []);
    const wm = new WatchManager(
        bus,
        { getPrInfoFn: getPrInfo, getChecksFn: getChecks, getPrFeedbackFn: getFeedback },
        { settleMs: 0 },
    );
    const server = createMcpServer({ bus, watchManager: wm });
    const client = new Client({ name: "test-client", version: "1.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanup.push(async () => {
        for (const handle of wm.allHandles()) wm.close(handle);
        await client.close();
        await server.close();
    });
    const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        return {
            response,
            data: JSON.parse((response.content as Array<{ text: string }>)[0]!.text) as Record<
                string,
                any
            >,
        };
    };
    const complete = (conclusion = "success") => {
        checks = [
            {
                id: "check_run:1",
                name: "ci",
                status: "completed",
                conclusion,
                sha: "sha1",
                url: "https://github.com/acme/demo/actions/runs/7/job/8",
            },
        ];
        bus.publish({ owner: "acme", repo: "demo", type: "check_run", ...checks[0]! });
    };
    const postFeedback = (author = "review-bot[bot]", body = "Please fix the unchecked error") => {
        const item: FeedbackItem = {
            id: "issue_comment:7",
            kind: "issue_comment",
            author,
            body,
            url: "https://github.com/acme/demo/pull/42#issuecomment-7",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        bus.publish({
            owner: "acme",
            repo: "demo",
            prNumber: 42,
            sha: "",
            type: "feedback",
            name: "pr:42",
            status: "created",
            conclusion: null,
            feedback: item,
        });
    };
    return { client, wm, call, complete, getPrInfo, getChecks, getFeedback, postFeedback };
}
const pr = { pr_url: "https://github.com/acme/demo/pull/42" };

describe("MCP wait workflow", () => {
    it("advertises announcement and continuation instructions", async () => {
        const { client } = await fixture();
        expect(client.getInstructions()).toBe(AGENT_INSTRUCTIONS);
        const result = await client.listTools();
        expect(result.tools.map((tool) => tool.name).sort()).toEqual([
            "await_pr_actions",
            "cancel_pr_watch",
            "get_pr_watch_status",
            "start_pr_watch",
            "wait_pr_watch",
        ]);
        expect(
            result.tools.find((tool) => tool.name === "await_pr_actions")?.description,
        ).toContain("I'm using the agent-actions-await tool");
    });

    it("returns an immediate handle and renders the requested announcement", async () => {
        const { call, getPrInfo } = await fixture();
        getPrInfo.mockImplementationOnce(() => new Promise(() => {}));
        const { data } = await call("start_pr_watch", pr);
        expect(data.handle).toMatch(/^[0-9a-f-]{36}$/);
        expect(data.state).toBe("pending");
        expect(data.announcement).toBe(
            "I'm using the agent-actions-await tool to await PR #42 feedback on acme/demo, and I will restart work once I am notified of it",
        );
    });

    it("awaits completion and preserves final results for repeated reads", async () => {
        const { call, complete, getChecks } = await fixture();
        const awaiting = call("await_pr_actions", pr);
        await vi.waitFor(() => expect(getChecks).toHaveBeenCalled());
        complete();
        const { data } = await awaiting;
        expect(data.state).toBe("completed");
        expect(data.outcome).toBe("passed");
        for (let i = 0; i < 2; i++) {
            expect((await call("get_pr_watch_status", { handle: data.handle })).data.state).toBe(
                "completed",
            );
        }
    });

    it("returns pending after a bounded wait and resumes the same handle", async () => {
        const { call, complete } = await fixture();
        const { data } = await call("await_pr_actions", { ...pr, wait_seconds: 1 });
        expect(data.state).toBe("pending");
        expect(data.next_action).toContain("wait_pr_watch");
        const waiting = call("wait_pr_watch", { handle: data.handle });
        complete();
        expect((await waiting).data.state).toBe("completed");
    });

    it("returns failed check links without treating completed as passed", async () => {
        const { call, complete, getChecks } = await fixture();
        const awaiting = call("await_pr_actions", pr);
        await vi.waitFor(() => expect(getChecks).toHaveBeenCalled());
        complete("failure");
        const { data } = await awaiting;
        expect(data.outcome).toBe("failed");
        expect(data.failed[0].url).toContain("/actions/runs/7/job/8");
    });

    it("cancels a watch and wakes an outstanding waiter", async () => {
        const { call } = await fixture();
        const { data } = await call("start_pr_watch", pr);
        const waiting = call("wait_pr_watch", { handle: data.handle });
        expect((await call("cancel_pr_watch", { handle: data.handle })).data.state).toBe(
            "cancelled",
        );
        expect((await waiting).data.state).toBe("cancelled");
    });

    it("surfaces initialization failures to the waiter", async () => {
        const { call, getPrInfo } = await fixture();
        getPrInfo.mockRejectedValueOnce(new Error("GitHub access denied"));
        const { response, data } = await call("await_pr_actions", pr);
        expect(response.isError).toBe(true);
        expect(data.state).toBe("failed");
        expect(data.error).toContain("access denied");
    });

    it("reports PR closure separately from passing checks", async () => {
        const { call, getPrInfo } = await fixture();
        getPrInfo.mockResolvedValueOnce({ sha: "sha1", state: "closed", merged: false });
        const { data } = await call("await_pr_actions", pr);
        expect(data.state).toBe("completed");
        expect(data.outcome).toBe("pr_closed");
    });

    it("returns structured errors for unknown handles and invalid inputs", async () => {
        const { call } = await fixture();
        expect((await call("wait_pr_watch", { handle: "unknown" })).response.isError).toBe(true);
        expect((await call("start_pr_watch", { pr_number: -1 })).response.isError).toBe(true);
        expect((await call("unknown", {})).response.isError).toBe(true);
    });

    it("watches feedback alone without querying checks", async () => {
        const { call, getChecks, getFeedback, postFeedback } = await fixture();
        const waiting = call("await_pr_actions", {
            ...pr,
            mode: "feedback",
            feedback_quiet_seconds: 0,
        });
        await vi.waitFor(() => expect(getFeedback).toHaveBeenCalled());
        postFeedback();
        const { data } = await waiting;
        expect(data.outcome).toBe("feedback_received");
        expect(data.checksOutcome).toBe("not_required");
        expect(data.feedback[0].body).toContain("unchecked error");
        expect(getChecks).not.toHaveBeenCalled();
    });

    it("both returns when CI finishes even without feedback", async () => {
        const { call, complete, getFeedback } = await fixture();
        const { data: start } = await call("start_pr_watch", {
            ...pr,
            mode: "both",
            feedback_authors: ["review-bot[bot]"],
            feedback_quiet_seconds: 0,
        });
        await vi.waitFor(() => expect(getFeedback).toHaveBeenCalled());
        complete();
        const { data } = await call("wait_pr_watch", { handle: start.handle });
        expect(data.completionReason).toBe("checks_settled");
        expect(data.state).toBe("completed");
        expect(data.outcome).toBe("passed");
        expect(data.feedbackState).toBe("waiting");
        expect(data.feedback).toEqual([]);
    });

    it("both returns matching feedback while CI is still pending", async () => {
        const { call, getFeedback, postFeedback } = await fixture();
        const { data: start } = await call("start_pr_watch", {
            ...pr,
            mode: "both",
            feedback_authors: ["review-bot[bot]"],
            feedback_quiet_seconds: 0,
        });
        await vi.waitFor(() => expect(getFeedback).toHaveBeenCalled());
        postFeedback("someone-else");
        expect((await call("get_pr_watch_status", { handle: start.handle })).data.feedback).toEqual(
            [],
        );
        postFeedback();
        const { data } = await call("wait_pr_watch", { handle: start.handle });
        expect(data.completionReason).toBe("feedback_received");
        expect(data.outcome).toBe("feedback_received");
        expect(data.checksState).toBe("waiting");
        expect(data.checksOutcome).toBe("pending");
        expect(data.feedback).toHaveLength(1);
    });

    it("validates mode-specific parameters", () => {
        expect(() => parseWatchInput({ ...pr, mode: "unknown" })).toThrow();
        expect(() => parseWatchInput({ ...pr, feedback_authors: ["bot"] })).toThrow(/require mode/);
        expect(() => parseWatchInput({ ...pr, mode: "feedback", filter: "ci" })).toThrow(
            /Check filters/,
        );
        expect(() =>
            parseWatchInput({ ...pr, mode: "both", feedback_quiet_seconds: 31 }),
        ).toThrow();
        expect(() => parseWatchInput({ ...pr, mode: "feedback", feedback_authors: [] })).toThrow();
    });

    it("rejects ambiguous or unrelated PR URLs", () => {
        expect(() => parseWatchInput({ ...pr, pr_number: 43 })).toThrow(/conflicts/);
        expect(() =>
            parseWatchInput({ pr_url: "https://github.com:444/acme/demo/pull/42" }),
        ).toThrow(/PR URL/);
        expect(() => parseWatchInput({ owner: "..", repo: "demo", pr_number: 42 })).toThrow();
        expect(() => parseWatchInput({ pr_url: "https://example.com/acme/demo/pull/42" })).toThrow(
            /PR URL/,
        );
        expect(parseWatchInput({ owner: "acme", repo: "demo", pr_number: 42 })).toMatchObject({
            owner: "acme",
            repo: "demo",
            prNumber: 42,
        });
    });
});
