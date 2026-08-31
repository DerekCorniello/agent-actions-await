import { describe, it, expect, vi } from "vitest";
import {
    resolveApiBase,
    resolveToken,
    filterChecks,
    isSettled,
    allSettled,
    getPrHeadSha,
    getChecksForSha,
    getChecksForShaWithGrace,
    type CheckInfo,
} from "../src/github.js";

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
            return new Response(JSON.stringify({ head: { sha: "abc123" } }), {
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
            return new Response(JSON.stringify({ head: { sha: "s" } }), {
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
