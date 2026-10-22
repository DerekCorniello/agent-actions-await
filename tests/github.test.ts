import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
vi.mock("node:child_process", () => ({
    execFileSync: vi.fn(() => {
        throw new Error("gh is unavailable in unit tests");
    }),
}));
import {
    resolveApiBase,
    resolveToken,
    filterChecks,
    isSettled,
    allSettled,
    getPrHeadSha,
    getPrInfo,
    getChecksForSha,
    getChecksForShaWithGrace,
    getPrFeedback,
    aggregateCheckOutcome,
    type CheckInfo,
} from "../src/github.js";

beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));
afterEach(() => vi.unstubAllEnvs());

function mockFetch(
    routes: Record<string, unknown | ((url: string, init: RequestInit) => unknown)>,
) {
    return vi.fn(async (url: string, init?: RequestInit) => {
        const key = Object.keys(routes).find((k) => url.includes(k));
        if (!key) return new Response("not found", { status: 404 });
        const val = routes[key]!;
        const body =
            typeof val === "function"
                ? (val as (u: string, i: RequestInit) => unknown)(url, init!)
                : val;
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    });
}

describe("resolveApiBase", () => {
    it("defaults to api.github.com", () => {
        expect(resolveApiBase({})).toBe("https://api.github.com");
    });
    it("honors GITHUB_API_URL", () => {
        expect(resolveApiBase({ GITHUB_API_URL: "https://example.com/api/v3/" })).toBe(
            "https://example.com/api/v3",
        );
    });
    it("derives GHE from GH_HOST", () => {
        expect(resolveApiBase({ GH_HOST: "ghe.example.com" })).toBe(
            "https://ghe.example.com/api/v3",
        );
    });
    it("passes through GH_HOST with /api/v3", () => {
        expect(resolveApiBase({ GH_HOST: "https://ghe.example.com/api/v3" })).toBe(
            "https://ghe.example.com/api/v3",
        );
    });
});

describe("resolveToken", () => {
    it("prefers GITHUB_TOKEN over GH_TOKEN", () => {
        expect(resolveToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" } as NodeJS.ProcessEnv)).toBe("a");
    });
    it("falls back to GH_TOKEN", () => {
        expect(resolveToken({ GH_TOKEN: "b" } as NodeJS.ProcessEnv)).toBe("b");
    });
    it("uses gh auth token when process credentials are absent", () => {
        const lookup = vi.fn(() => "from-gh");
        expect(resolveToken({} as NodeJS.ProcessEnv, lookup)).toBe("from-gh");
        expect(lookup).toHaveBeenCalledWith(expect.any(String));
    });
    it("derives gh hostname from the API URL", () => {
        const lookup = vi.fn(() => "from-ghe");
        expect(
            resolveToken(
                { GITHUB_API_URL: "https://ghe.example/api/v3" } as NodeJS.ProcessEnv,
                lookup,
                "https://ghe.example/api/v3",
            ),
        ).toBe("from-ghe");
        expect(lookup).toHaveBeenCalledWith("ghe.example");
    });
    it("bounds the gh auth subprocess and does not expose its failure", () => {
        expect(resolveToken({} as NodeJS.ProcessEnv)).toBeUndefined();
        expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
            "gh",
            ["auth", "token", "--hostname", "github.com"],
            expect.objectContaining({ timeout: 5000 }),
        );
    });
});

describe("filterChecks + isSettled", () => {
    const checks: CheckInfo[] = [
        { name: "ci", status: "completed", conclusion: "success", sha: "s" },
        { name: "lint", status: "in_progress", conclusion: null, sha: "s" },
        { name: "ci", status: "completed", conclusion: "failure", sha: "s" }, // matrix duplicate name
    ];
    it("filter 'all' returns all", () => expect(filterChecks(checks, "all")).toHaveLength(3));
    it("filter single string exact match", () =>
        expect(filterChecks(checks, "lint")).toHaveLength(1));
    it("filter array exact match aggregates duplicates", () =>
        expect(filterChecks(checks, ["ci"])).toHaveLength(2));
    it("isSettled true for completed or non-null conclusion", () => {
        expect(isSettled({ name: "x", status: "completed", conclusion: "success", sha: "s" })).toBe(
            true,
        );
        expect(isSettled({ name: "x", status: "pending", conclusion: null, sha: "s" })).toBe(false);
        expect(
            isSettled({
                name: "x",
                status: "pending",
                conclusion: "success",
                sha: "s",
            } as CheckInfo),
        ).toBe(true);
    });
    it("allSettled false if any pending or empty", () => {
        expect(allSettled(checks)).toBe(false);
        expect(allSettled([])).toBe(false);
        expect(
            allSettled([{ name: "a", status: "completed", conclusion: "success", sha: "s" }]),
        ).toBe(true);
    });
});

describe("getPrHeadSha", () => {
    it("resolves head sha via pulls API and uses token header", async () => {
        let authHeader: string | undefined;
        const ff = vi.fn(async (url: string, init: RequestInit) => {
            authHeader = (init.headers as Record<string, string>).Authorization;
            expect(url).toContain("/repos/acme/demo/pulls/42");
            return new Response(JSON.stringify({ head: { sha: "abc123" }, state: "open" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const sha = await getPrHeadSha({
            owner: "acme",
            repo: "demo",
            prNumber: 42,
            auth: { token: "tok", apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(sha).toBe("abc123");
        expect(authHeader).toBe("Bearer tok");
    });

    it("throws on 404 with body", async () => {
        const ff = vi.fn(async () => new Response("no pull", { status: 404 }));
        await expect(
            getPrHeadSha({
                owner: "acme",
                repo: "demo",
                prNumber: 999,
                auth: { apiBase: "https://api.github.com" },
                fetchFn: ff as unknown as typeof fetch,
            }),
        ).rejects.toThrow(/404/);
    });

    it("respects apiBase from env GH_HOST (GHE compat Q38)", async () => {
        const ff = vi.fn(async (url: string) => {
            expect(url).toContain("https://ghe.example.com/api/v3/repos");
            return new Response(JSON.stringify({ head: { sha: "s" }, state: "open" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        await getPrHeadSha({
            owner: "o",
            repo: "r",
            prNumber: 1,
            env: { GH_HOST: "ghe.example.com" } as NodeJS.ProcessEnv,
            fetchFn: ff as unknown as typeof fetch,
        });
    });
});

describe("getPrInfo", () => {
    it("returns SHA and lifecycle state", async () => {
        const info = await getPrInfo({
            owner: "acme",
            repo: "demo",
            prNumber: 42,
            auth: { apiBase: "https://api.github.com" },
            fetchFn: vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            head: { sha: "abc" },
                            state: "closed",
                            merged: true,
                        }),
                        { status: 200 },
                    ),
            ) as unknown as typeof fetch,
        });
        expect(info).toEqual({ sha: "abc", state: "closed", merged: true });
    });
});

describe("getChecksForSha", () => {
    it("combines check_runs + statuses (Q28)", async () => {
        const ff = mockFetch({
            "/check-runs": {
                check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
            },
            "/status": { statuses: [{ context: "ci/legacy", state: "success" }], state: "success" },
        });
        const checks = await getChecksForSha({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(checks).toHaveLength(2);
        expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["ci", "ci/legacy"]));
    });

    it("handles 404 on check-runs gracefully (no checks yet)", async () => {
        const ff = vi.fn(async (url: string) => {
            if (url.includes("check-runs")) return new Response("no", { status: 404 });
            return new Response(JSON.stringify({ statuses: [], state: "pending" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const checks = await getChecksForSha({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(checks).toHaveLength(0);
    });

    it("backoffs on 429 with Retry-After (Q33) then succeeds", async () => {
        let calls = 0;
        const ff = vi.fn(async () => {
            calls++;
            if (calls === 1)
                return new Response("rate", {
                    status: 429,
                    headers: { "retry-after": "0", "content-type": "text/plain" },
                });
            if (calls === 2)
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
        const checks = await getChecksForSha({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(checks.some((c) => c.name === "ci")).toBe(true);
    });

    it("paginates both endpoints and preserves identity and useful links", async () => {
        const calls: string[] = [];
        const ff = vi.fn(async (url: string) => {
            calls.push(url);
            if (url.includes("check-runs")) {
                if (url.includes("page=2"))
                    return new Response(
                        JSON.stringify({
                            check_runs: [
                                {
                                    id: 2,
                                    name: "build",
                                    status: "completed",
                                    conclusion: "success",
                                    html_url: "https://github/run/2",
                                    run_id: 19,
                                },
                            ],
                        }),
                        { status: 200 },
                    );
                return new Response(
                    JSON.stringify({
                        check_runs: [
                            {
                                id: 1,
                                name: "build",
                                status: "completed",
                                conclusion: "failure",
                                html_url: "https://github/run/1",
                                run_id: 18,
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: {
                            link: '<https://api.github.com/repos/acme/demo/commits/s/check-runs?per_page=100&page=2>; rel="next"',
                        },
                    },
                );
            }
            if (url.includes("page=2"))
                return new Response(
                    JSON.stringify({
                        statuses: [
                            {
                                id: 4,
                                context: "deploy-older",
                                state: "success",
                                target_url: "https://deploy/4",
                            },
                        ],
                    }),
                    { status: 200 },
                );
            return new Response(
                JSON.stringify({ statuses: [{ id: 3, context: "deploy", state: "pending" }] }),
                {
                    status: 200,
                    headers: {
                        link: '<https://api.github.com/repos/acme/demo/commits/s/status?per_page=100&page=2>; rel="next"',
                    },
                },
            );
        });
        const checks = await getChecksForSha({
            owner: "acme",
            repo: "demo",
            sha: "s",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(checks).toHaveLength(4);
        expect(checks[0]).toMatchObject({
            id: "check_run:1",
            url: "https://github/run/1",
            runId: 18,
        });
        expect(checks[3]).toMatchObject({ id: "status:deploy-older", url: "https://deploy/4" });
        expect(calls.filter((url) => url.includes("check-runs"))).toHaveLength(2);
        expect(calls.filter((url) => url.includes("/status"))).toHaveLength(2);
    });

    it("surfaces commit status errors", async () => {
        const ff = vi.fn(async (url: string) =>
            url.includes("check-runs")
                ? new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
                : new Response("forbidden", { status: 403 }),
        );
        await expect(
            getChecksForSha({
                owner: "o",
                repo: "r",
                sha: "s",
                auth: { apiBase: "https://api.github.com" },
                fetchFn: ff as unknown as typeof fetch,
            }),
        ).rejects.toThrow(/statuses failed 403/);
    });

    it("rejects pagination links to another origin", async () => {
        const ff = vi.fn(
            async () =>
                new Response(JSON.stringify({ check_runs: [] }), {
                    status: 200,
                    headers: { link: '<https://attacker.example/steal?x=1>; rel="next"' },
                }),
        );
        await expect(
            getChecksForSha({
                owner: "o",
                repo: "r",
                sha: "s",
                auth: { apiBase: "https://api.github.com" },
                fetchFn: ff as unknown as typeof fetch,
            }),
        ).rejects.toThrow(/changed API origin/);
        expect(ff).toHaveBeenCalledTimes(1);
    });
});

describe("aggregateCheckOutcome", () => {
    it("distinguishes empty, pending, failed, and passed", () => {
        expect(aggregateCheckOutcome([])).toBe("no_checks");
        expect(
            aggregateCheckOutcome([{ name: "x", status: "queued", conclusion: null, sha: "s" }]),
        ).toBe("pending");
        expect(
            aggregateCheckOutcome([
                { name: "x", status: "completed", conclusion: "failure", sha: "s" },
            ]),
        ).toBe("failed");
        expect(
            aggregateCheckOutcome([
                { name: "x", status: "completed", conclusion: "success", sha: "s" },
            ]),
        ).toBe("passed");
        for (const conclusion of ["neutral", "skipped"]) {
            expect(
                aggregateCheckOutcome([{ name: "x", status: "completed", conclusion, sha: "s" }]),
            ).toBe("passed");
        }
    });
});

describe("getPrFeedback", () => {
    it("fetches all feedback types, paginates, and authenticates requests", async () => {
        const calls: Array<{ url: string; authorization: string | undefined }> = [];
        const ff = vi.fn(async (url: string, init: RequestInit) => {
            calls.push({
                url,
                authorization: (init.headers as Record<string, string>).Authorization,
            });
            if (url.includes("issues/42/comments")) {
                if (url.includes("page=2")) {
                    return new Response(
                        JSON.stringify([
                            {
                                id: 2,
                                user: { login: "two" },
                                body: "second",
                                html_url: "https://github.test/2",
                                created_at: "2026-01-02T00:00:00Z",
                                updated_at: "2026-01-02T00:00:00Z",
                            },
                        ]),
                        { status: 200 },
                    );
                }
                return new Response(
                    JSON.stringify([
                        {
                            id: 1,
                            user: { login: "one" },
                            body: "first",
                            html_url: "https://github.test/1",
                            created_at: "2026-01-01T00:00:00Z",
                            updated_at: "2026-01-01T00:00:00Z",
                        },
                    ]),
                    {
                        status: 200,
                        headers: {
                            link: '<https://api.github.com/repos/acme/demo/issues/42/comments?per_page=100&page=2>; rel="next"',
                        },
                    },
                );
            }
            if (url.includes("pulls/42/comments")) {
                if (url.includes("page=2")) {
                    return new Response(
                        JSON.stringify([
                            {
                                id: 6,
                                user: { login: "reviewer" },
                                body: "inline second",
                                html_url: "https://github.test/inline/6",
                                created_at: "2026-01-03T12:00:00Z",
                                updated_at: "2026-01-03T12:00:00Z",
                            },
                        ]),
                        { status: 200 },
                    );
                }
                return new Response(
                    JSON.stringify([
                        {
                            id: 3,
                            pull_request_review_id: 4,
                            user: { login: "reviewer" },
                            body: "inline",
                            html_url: "https://github.test/inline",
                            path: "src/a.ts",
                            line: 8,
                            commit_id: "abc",
                            created_at: "2026-01-03T00:00:00Z",
                            updated_at: "2026-01-03T01:00:00Z",
                        },
                        {
                            id: 7,
                            pull_request_review_id: 5,
                            user: { login: "reviewer" },
                            body: "draft inline",
                            html_url: "https://github.test/inline/draft",
                            created_at: "2026-01-03T02:00:00Z",
                            updated_at: "2026-01-03T02:00:00Z",
                        },
                    ]),
                    {
                        status: 200,
                        headers: {
                            link: '<https://api.github.com/repos/acme/demo/pulls/42/comments?per_page=100&page=2>; rel="next"',
                        },
                    },
                );
            }
            if (url.includes("pulls/42/reviews") && !url.includes("page=2")) {
                return new Response(
                    JSON.stringify([
                        {
                            id: 5,
                            user: { login: "reviewer" },
                            body: "draft",
                            state: "PENDING",
                            html_url: "https://github.test/pending",
                        },
                    ]),
                    {
                        status: 200,
                        headers: {
                            link: '<https://api.github.com/repos/acme/demo/pulls/42/reviews?per_page=100&page=2>; rel="next"',
                        },
                    },
                );
            }
            return new Response(
                JSON.stringify([
                    {
                        id: 4,
                        user: { login: "reviewer" },
                        body: "approved",
                        state: "APPROVED",
                        html_url: "https://github.test/review",
                        commit_id: "def",
                        submitted_at: "2026-01-04T00:00:00Z",
                    },
                ]),
                { status: 200 },
            );
        });
        const items = await getPrFeedback({
            owner: "acme",
            repo: "demo",
            prNumber: 42,
            auth: { token: "secret-token", apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
        });
        expect(items.map((item) => item.id)).toEqual([
            "issue_comment:1",
            "issue_comment:2",
            "review_comment:3",
            "review_comment:6",
            "review:4",
        ]);
        expect(items[2]).toMatchObject({ path: "src/a.ts", line: 8, commitId: "abc" });
        expect(items[2]).toMatchObject({
            createdAt: "2026-01-03T00:00:00.000Z",
            updatedAt: "2026-01-04T00:00:00.000Z",
        });
        expect(items[4]).toMatchObject({
            createdAt: "2026-01-04T00:00:00.000Z",
            updatedAt: "2026-01-04T00:00:00.000Z",
        });
        expect(calls).toHaveLength(6);
        expect(calls.every((call) => call.authorization === "Bearer secret-token")).toBe(true);
    });

    it("surfaces errors from any feedback endpoint", async () => {
        const ff = vi.fn(async (url: string) =>
            url.includes("pulls/42/reviews")
                ? new Response("denied", { status: 403 })
                : new Response("[]", { status: 200 }),
        );
        await expect(
            getPrFeedback({
                owner: "acme",
                repo: "demo",
                prNumber: 42,
                auth: { apiBase: "https://api.github.com" },
                fetchFn: ff as unknown as typeof fetch,
            }),
        ).rejects.toThrow(/review for acme\/demo#42 failed 403/);
    });
});

describe("getChecksForShaWithGrace (Q21)", () => {
    it("returns immediately if checks exist", async () => {
        const ff = mockFetch({
            "/check-runs": {
                check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
            },
            "/status": { statuses: [], state: "success" },
        });
        const checks = await getChecksForShaWithGrace({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
            graceMs: 50,
            pollIntervalMs: 10,
        });
        expect(checks).toHaveLength(1);
    });

    it("polls until first check appears within grace", async () => {
        let calls = 0;
        const ff = vi.fn(async (url: string) => {
            if (url.includes("check-runs")) {
                calls++;
                if (calls <= 2)
                    return new Response(JSON.stringify({ check_runs: [] }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    });
                return new Response(
                    JSON.stringify({
                        check_runs: [{ name: "ci", status: "queued", conclusion: null }],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            return new Response(JSON.stringify({ statuses: [], state: "pending" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const start = Date.now();
        const checks = await getChecksForShaWithGrace({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
            graceMs: 1000,
            pollIntervalMs: 10,
        });
        expect(checks.length).toBeGreaterThan(0);
        expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    });

    it("returns empty after grace if GitHub never creates checks", async () => {
        const ff = mockFetch({
            "/check-runs": { check_runs: [] },
            "/status": { statuses: [], state: "pending" },
        });
        const checks = await getChecksForShaWithGrace({
            owner: "acme",
            repo: "demo",
            sha: "sha1",
            auth: { apiBase: "https://api.github.com" },
            fetchFn: ff as unknown as typeof fetch,
            graceMs: 30,
            pollIntervalMs: 10,
        });
        expect(checks).toHaveLength(0);
    });
});
