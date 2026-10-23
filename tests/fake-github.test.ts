import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHubApi, FAKE_GITHUB_TOKEN } from "../src/fake-github.js";

describe("fake GitHub API", () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    async function start() {
        const api = await startFakeGitHubApi({ port: 0 });
        close = () =>
            new Promise((resolve, reject) =>
                api.server.close((error) => (error ? reject(error) : resolve())),
            );
        return api.url;
    }

    it("serves a pending PR and check runs in GitHub REST response shapes", async () => {
        const base = await start();
        const pullRequest = await fetch(`${base}/repos/acme/demo/pulls/42`).then((res) =>
            res.json(),
        );
        const checks = await fetch(`${base}/repos/acme/demo/commits/fake-sha-1/check-runs`).then(
            (res) => res.json(),
        );
        expect(pullRequest).toMatchObject({
            state: "open",
            merged: false,
            head: { sha: "fake-sha-1" },
        });
        expect(
            checks.check_runs.map((check: { name: string; status: string }) => [
                check.name,
                check.status,
            ]),
        ).toEqual([
            ["lint", "in_progress"],
            ["test", "in_progress"],
        ]);
        expect(FAKE_GITHUB_TOKEN).toBe("fake-github-token");
    });

    it("can pass or fail checks and advance the PR head", async () => {
        const base = await start();
        const scenario = (action: string) =>
            fetch(`${base}/__fake/scenario`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action }),
            });
        expect((await scenario("fail")).status).toBe(200);
        let checks = await fetch(`${base}/repos/acme/demo/commits/fake-sha-1/check-runs`).then(
            (res) => res.json(),
        );
        expect(checks.check_runs.map((check: { conclusion: string }) => check.conclusion)).toEqual([
            "success",
            "failure",
        ]);
        expect((await scenario("push")).status).toBe(200);
        const pr = await fetch(`${base}/repos/acme/demo/pulls/42`).then((res) => res.json());
        expect(pr.head.sha).toBe("fake-sha-2");
        checks = await fetch(`${base}/repos/acme/demo/commits/fake-sha-2/check-runs`).then((res) =>
            res.json(),
        );
        expect(
            checks.check_runs.every((check: { status: string }) => check.status === "in_progress"),
        ).toBe(true);
    });

    it("serves fake conversation comments, reviews, and inline comments", async () => {
        const base = await start();
        const scenario = (action: string) =>
            fetch(`${base}/__fake/scenario`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action }),
            });
        await scenario("comment");
        await scenario("review");
        const [issues, reviews, inline] = await Promise.all([
            fetch(`${base}/repos/acme/demo/issues/42/comments`).then((res) => res.json()),
            fetch(`${base}/repos/acme/demo/pulls/42/reviews`).then((res) => res.json()),
            fetch(`${base}/repos/acme/demo/pulls/42/comments`).then((res) => res.json()),
        ]);
        expect(issues).toHaveLength(1);
        expect(reviews[0]).toMatchObject({
            state: "CHANGES_REQUESTED",
            user: { login: "review-bot[bot]" },
        });
        expect(inline[0]).toMatchObject({
            path: "src/example.ts",
            pull_request_review_id: reviews[0].id,
        });
    });

    it("rejects unknown scenarios and unknown API routes", async () => {
        const base = await start();
        const invalid = await fetch(`${base}/__fake/scenario`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "merge" }),
        });
        expect(invalid.status).toBe(400);
        const missing = await fetch(`${base}/repos/acme/demo/issues/404/comments`);
        expect(missing.status).toBe(404);
    });
});
