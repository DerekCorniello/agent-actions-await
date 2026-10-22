import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { createHttpServer } from "../src/http-server.js";
import { computeSignature } from "../src/webhook.js";
import type { CheckInfo } from "../src/github.js";

describe("signed feedback webhook to combined watch", () => {
    it("returns a new PR comment while CI remains pending", async () => {
        const bus = new EventBus();
        const checks: CheckInfo[] = [
            {
                id: "check_run:9",
                name: "test",
                sha: "head",
                status: "in_progress",
                conclusion: null,
            },
        ];
        const wm = new WatchManager(
            bus,
            {
                getPrInfoFn: async () => ({ sha: "head", state: "open", merged: false }),
                getChecksFn: async () => checks,
                getPrFeedbackFn: async () => [],
            },
            { settleMs: 0 },
        );
        const secret = "integration-test-secret";
        const { server, url } = await createHttpServer({ bus, getSecret: () => secret });
        let handle: string | undefined;
        try {
            handle = await wm.startWatch({
                owner: "acme",
                repo: "demo",
                prNumber: 42,
                mode: "both",
                feedbackQuietMs: 0,
            });
            await vi.waitFor(() =>
                expect(wm.getStatus(handle!)).toMatchObject({
                    checksState: "waiting",
                    state: "pending",
                }),
            );
            const now = new Date().toISOString();
            const body = Buffer.from(
                JSON.stringify({
                    action: "created",
                    repository: { owner: { login: "acme" }, name: "demo" },
                    issue: {
                        number: 42,
                        pull_request: { url: "https://api.github.com/repos/acme/demo/pulls/42" },
                    },
                    comment: {
                        id: 20,
                        user: { login: "review-bot[bot]" },
                        body: "Check the error path",
                        html_url: "https://github.com/acme/demo/pull/42#issuecomment-20",
                        created_at: now,
                        updated_at: now,
                    },
                }),
            );
            const response = await fetch(`${url}/webhook`, {
                method: "POST",
                headers: {
                    "X-GitHub-Event": "issue_comment",
                    "X-GitHub-Delivery": "feedback-integration",
                    "X-Hub-Signature-256": computeSignature(secret, body),
                },
                body,
            });
            expect(response.status).toBe(200);
            const result = await wm.waitForWatch(handle, undefined, 1000);
            expect(result).toMatchObject({
                state: "completed",
                completionReason: "feedback_received",
                checksState: "waiting",
                feedbackState: "ready",
            });
            expect(result?.feedback).toHaveLength(1);
            expect(result?.feedback[0]).toMatchObject({
                id: "issue_comment:20",
                author: "review-bot[bot]",
                body: "Check the error path",
            });
        } finally {
            if (handle) wm.close(handle);
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});
