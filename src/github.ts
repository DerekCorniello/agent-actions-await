import { execFileSync } from "node:child_process";
import { normalizeFeedback, type FeedbackItem, type FeedbackKind } from "./feedback.js";

/**
 * GitHub REST helpers per PLAN.md:84+148 and grill Q4/Q9/Q21/Q33/Q38/Q39.
 *
 * - Resolve PR number → head SHA (baseOwner/baseRepo@sha keying, fork-safe)
 * - Fetch expected check set for SHA (all checks by default, optional filter)
 * - Grace for initial creation race (poll until first check appears or 60s)
 * - Rate-limit backoff with Retry-After
 * - GH_HOST / GITHUB_API_URL aware (dotcom + GHE)
 */

export type GhAuth = {
    token?: string;
    apiBase?: string;
};

export type CheckInfo = {
    name: string;
    status: string;
    conclusion: string | null;
    sha: string;
    id?: string;
    url?: string;
    runId?: number;
};

export type GhTokenFn = (hostname: string) => string | undefined;
export type PrInfo = { sha: string; state: "open" | "closed"; merged: boolean };
const GH_AUTH_TIMEOUT_MS = 5_000;

const ghAuthToken: GhTokenFn = (hostname) => {
    try {
        return (
            execFileSync("gh", ["auth", "token", "--hostname", hostname], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: GH_AUTH_TIMEOUT_MS,
            }).trim() || undefined
        );
    } catch {
        return undefined;
    }
};

export type FetchFn = typeof fetch;

export function resolveApiBase(env: NodeJS.ProcessEnv = process.env): string {
    if (env.GITHUB_API_URL) return env.GITHUB_API_URL.replace(/\/$/, "");
    const host = env.GH_HOST ?? env.GITHUB_HOST ?? "github.com";
    if (host === "github.com" || host === "api.github.com") return "https://api.github.com";
    // GHE: https://<host>/api/v3
    const clean = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (clean.includes("/api/v3")) return `https://${clean}`.replace(/\/$/, "");
    return `https://${clean}/api/v3`;
}

export function resolveToken(
    env: NodeJS.ProcessEnv = process.env,
    ghTokenFn: GhTokenFn = ghAuthToken,
    apiBase?: string,
): string | undefined {
    const envToken = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_PAT;
    if (envToken) return envToken;
    const configuredHost = (
        apiBase ??
        env.GITHUB_API_URL ??
        env.GH_HOST ??
        env.GITHUB_HOST ??
        "github.com"
    )
        .replace(/^https?:\/\//, "")
        .split("/")[0]!;
    const host = configuredHost === "api.github.com" ? "github.com" : configuredHost;
    return ghTokenFn(host);
}

export type CheckOutcome = "passed" | "failed" | "pending" | "no_checks";

export function aggregateCheckOutcome(checks: CheckInfo[]): CheckOutcome {
    if (!checks.length) return "no_checks";
    if (checks.some((check) => !isSettled(check))) return "pending";
    const successfulConclusions = new Set(["success", "neutral", "skipped"]);
    return checks.some((check) => !successfulConclusions.has(check.conclusion ?? check.status))
        ? "failed"
        : "passed";
}

export function failedChecks(checks: CheckInfo[]): CheckInfo[] {
    const successfulConclusions = new Set(["success", "neutral", "skipped"]);
    return checks.filter(
        (check) => isSettled(check) && !successfulConclusions.has(check.conclusion ?? check.status),
    );
}

/**
 * Filter matching per Q17: exact name match, `all` default, string | string[].
 * Matrix jobs: same name appears multiple times — all must settle, so we keep all entries.
 */
export type CheckFilter = "all" | string | string[];

export function filterChecks(checks: CheckInfo[], filter: CheckFilter): CheckInfo[] {
    if (filter === "all") return checks;
    const wanted = Array.isArray(filter) ? filter : [filter];
    const set = new Set(wanted);
    return checks.filter((c) => set.has(c.name));
}

export function isSettled(c: CheckInfo): boolean {
    // GitHub check_run.status: queued|in_progress|completed ; conclusion when completed
    // status API: pending|success|failure
    return (
        c.status === "completed" ||
        c.status === "success" ||
        c.status === "failure" ||
        c.status === "error" ||
        c.conclusion !== null
    );
}

export function allSettled(checks: CheckInfo[]): boolean {
    if (checks.length === 0) return false; // per Q21, 0 is not done — handled by grace outside
    return checks.every(isSettled);
}

export function summarize(checks: CheckInfo[]): { pending: CheckInfo[]; completed: CheckInfo[] } {
    return {
        pending: checks.filter((c) => !isSettled(c)),
        completed: checks.filter(isSettled),
    };
}

// Backoff helper for 403/429 with Retry-After (Q33)
async function fetchWithBackoff(
    url: string,
    init: RequestInit,
    fetchFn: FetchFn,
    maxRetries = 3,
): Promise<Response> {
    let attempt = 0;
    while (true) {
        const res = await fetchFn(url, init);
        if (res.status !== 429 && res.status !== 403) return res;
        // GitHub returns Retry-After for secondary rate limits; also check X-RateLimit-Remaining
        const retryAfter = res.headers.get("retry-after");
        const rateLimited = res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429;
        if (!rateLimited && res.status === 403) return res; // 403 not rate-limit (e.g. permissions) — don't retry
        if (attempt >= maxRetries) return res;
        const baseMs = retryAfter ? Number(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        const jitter = Math.random() * 500;
        await new Promise((r) => setTimeout(r, baseMs + jitter));
        attempt++;
    }
}

/**
 * Resolve PR head SHA. Uses /repos/{owner}/{repo}/pulls/{prNumber}
 * Fork-safe: returns head.sha, caller keys by baseOwner/baseRepo@sha per Q39.
 */
export type GitHubRequestOptions = {
    owner: string;
    repo: string;
    auth?: GhAuth | undefined;
    fetchFn?: FetchFn | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    ghTokenFn?: GhTokenFn | undefined;
};

export async function getPrInfo(
    opts: GitHubRequestOptions & { prNumber: number },
): Promise<PrInfo> {
    const apiBase = opts.auth?.apiBase ?? resolveApiBase(opts.env);
    const token = opts.auth?.token ?? resolveToken(opts.env, opts.ghTokenFn, apiBase);
    const ff = opts.fetchFn ?? fetch;
    const url = `${apiBase}/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}`;
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchWithBackoff(url, { headers }, ff);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
            `getPrInfo ${opts.owner}/${opts.repo}#${opts.prNumber} failed ${res.status}: ${body}`,
        );
    }
    const j = (await res.json()) as { head?: { sha?: string }; state?: string; merged?: boolean };
    if (!j.head?.sha || (j.state !== "open" && j.state !== "closed"))
        throw new Error("getPrInfo: response missing head.sha or valid state");
    return { sha: j.head.sha, state: j.state, merged: j.merged === true };
}

export async function getPrHeadSha(
    opts: GitHubRequestOptions & { prNumber: number },
): Promise<string> {
    const info = await getPrInfo(opts);
    return info.sha;
}

/** Fetch all issue comments, inline review comments, and submitted reviews for a pull request. */
export async function getPrFeedback(
    opts: GitHubRequestOptions & { prNumber: number },
): Promise<FeedbackItem[]> {
    const apiBase = opts.auth?.apiBase ?? resolveApiBase(opts.env);
    const token = opts.auth?.token ?? resolveToken(opts.env, opts.ghTokenFn, apiBase);
    const fetchFn = opts.fetchFn ?? fetch;
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const repoPath = `/repos/${opts.owner}/${opts.repo}`;
    const endpoints: Array<{ kind: FeedbackKind; path: string }> = [
        { kind: "issue_comment", path: `${repoPath}/issues/${opts.prNumber}/comments` },
        { kind: "review_comment", path: `${repoPath}/pulls/${opts.prNumber}/comments` },
        { kind: "review", path: `${repoPath}/pulls/${opts.prNumber}/reviews` },
    ];
    const batches = await Promise.all(
        endpoints.map(async ({ kind, path }) => {
            const records = await fetchAllPages<unknown>(
                `${apiBase}${path}?per_page=100`,
                `${kind} for ${opts.owner}/${opts.repo}#${opts.prNumber}`,
                headers,
                fetchFn,
                apiBase,
            );
            return { kind, records };
        }),
    );
    const submittedAtByReviewId = new Map<string, string>();
    const pendingReviewIds = new Set<string>();
    for (const batch of batches) {
        if (batch.kind !== "review") continue;
        for (const raw of batch.records) {
            if (!raw || typeof raw !== "object") continue;
            const review = raw as Record<string, unknown>;
            const id = review.id;
            const submittedAt = review.submitted_at;
            if (typeof id !== "number" && typeof id !== "string") continue;
            const reviewId = String(id);
            if (typeof review.state === "string" && review.state.toUpperCase() === "PENDING") {
                pendingReviewIds.add(reviewId);
                continue;
            }
            if (typeof submittedAt === "string") {
                submittedAtByReviewId.set(reviewId, submittedAt);
            }
        }
    }
    const items: FeedbackItem[] = [];
    for (const batch of batches) {
        for (const raw of batch.records) {
            let itemRaw = raw;
            if (batch.kind === "review_comment" && raw && typeof raw === "object") {
                const comment = raw as Record<string, unknown>;
                const reviewId = comment.pull_request_review_id;
                if (
                    (typeof reviewId === "number" || typeof reviewId === "string") &&
                    pendingReviewIds.has(String(reviewId))
                ) {
                    continue;
                }
                const submittedAt =
                    typeof reviewId === "number" || typeof reviewId === "string"
                        ? submittedAtByReviewId.get(String(reviewId))
                        : undefined;
                if (submittedAt) itemRaw = { ...comment, review_submitted_at: submittedAt };
            }
            const item = normalizeFeedback(batch.kind, itemRaw);
            if (item) items.push(item);
        }
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function fetchAllPages<T>(
    firstUrl: string,
    description: string,
    headers: Record<string, string>,
    fetchFn: FetchFn,
    apiBase: string,
): Promise<T[]> {
    const records: T[] = [];
    let pageUrl: string | undefined = firstUrl;
    while (pageUrl) {
        const response = await fetchWithBackoff(pageUrl, { headers }, fetchFn);
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`getPrFeedback ${description} failed ${response.status}: ${body}`);
        }
        const page = (await response.json()) as unknown;
        if (!Array.isArray(page)) {
            throw new Error(`getPrFeedback ${description} returned a non-array page`);
        }
        records.push(...(page as T[]));
        pageUrl = nextPage(response.headers.get("link"), apiBase);
    }
    return records;
}

/**
 * Fetch checks for a SHA. Combines check-runs + commit statuses for Q28 coverage.
 * Returns normalized CheckInfo[].
 */
export async function getChecksForSha(
    opts: GitHubRequestOptions & {
        sha: string;
        auth?: GhAuth | undefined;
        fetchFn?: FetchFn | undefined;
    },
): Promise<CheckInfo[]> {
    const apiBase = opts.auth?.apiBase ?? resolveApiBase(opts.env);
    const token = opts.auth?.token ?? resolveToken(opts.env, opts.ghTokenFn, apiBase);
    const ff = opts.fetchFn ?? fetch;
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    // Check-runs for SHA
    const crUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/check-runs?per_page=100`;
    const checkRuns: CheckInfo[] = [];
    let nextUrl: string | undefined = crUrl;
    while (nextUrl) {
        const crRes = await fetchWithBackoff(nextUrl, { headers }, ff);
        if (!crRes.ok) {
            if (crRes.status === 404 && nextUrl === crUrl) break;
            const body = await crRes.text().catch(() => "");
            throw new Error(`getChecksForSha check-runs failed ${crRes.status}: ${body}`);
        }
        const j = (await crRes.json()) as {
            check_runs?: Array<{
                id?: number;
                name: string;
                status: string;
                conclusion: string | null;
                html_url?: string;
                run_id?: number;
            }>;
        };
        checkRuns.push(
            ...(j.check_runs ?? []).map((c) => ({
                name: c.name,
                status: c.status,
                conclusion: c.conclusion,
                sha: opts.sha,
                ...(c.id !== undefined ? { id: `check_run:${c.id}` } : {}),
                ...(c.html_url ? { url: c.html_url } : {}),
                ...(c.run_id !== undefined ? { runId: c.run_id } : {}),
            })),
        );
        nextUrl = nextPage(crRes.headers.get("link"), apiBase);
    }

    // Commit statuses (legacy) for completeness
    const stUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/status?per_page=100`;
    const statusesByContext = new Map<string, CheckInfo>();
    nextUrl = stUrl;
    while (nextUrl) {
        const stRes = await fetchWithBackoff(nextUrl, { headers }, ff);
        if (!stRes.ok) {
            const body = await stRes.text().catch(() => "");
            throw new Error(`getChecksForSha statuses failed ${stRes.status}: ${body}`);
        }
        const j = (await stRes.json()) as {
            statuses?: Array<{ id?: number; context: string; state: string; target_url?: string }>;
        };
        // For combined status, each individual status is a CheckInfo
        for (const s of j.statuses ?? []) {
            if (statusesByContext.has(s.context)) continue;
            statusesByContext.set(s.context, {
                name: s.context,
                status: s.state === "pending" ? "pending" : "completed",
                conclusion: s.state === "pending" ? null : s.state,
                sha: opts.sha,
                id: `status:${s.context}`,
                ...(s.target_url ? { url: s.target_url } : {}),
            });
        }
        nextUrl = nextPage(stRes.headers.get("link"), apiBase);
    }
    return [...checkRuns, ...statusesByContext.values()];
}

function nextPage(linkHeader: string | null, apiBase: string): string | undefined {
    if (!linkHeader) return undefined;
    const next = linkHeader.split(",").find((part) => /;\s*rel="?next"?/.test(part));
    const nextUrl = next?.match(/<([^>]+)>/)?.[1];
    if (!nextUrl) return undefined;
    const parsedNext = new URL(nextUrl, apiBase);
    if (parsedNext.origin !== new URL(apiBase).origin) {
        throw new Error("GitHub pagination link changed API origin");
    }
    return parsedNext.toString();
}

/**
 * Grace for creation race (Q21): if 0 checks, poll again up to graceMs or until at least one appears.
 * Uses pollIntervalMs between attempts.
 */
export async function getChecksForShaWithGrace(opts: {
    owner: string;
    repo: string;
    sha: string;
    auth?: GhAuth | undefined;
    fetchFn?: FetchFn | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    ghTokenFn?: GhTokenFn | undefined;
    graceMs?: number | undefined;
    pollIntervalMs?: number | undefined;
}): Promise<CheckInfo[]> {
    const graceMs = opts.graceMs ?? 60_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const start = Date.now();
    while (true) {
        const checks = await getChecksForSha(opts);
        if (checks.length > 0) return checks;
        if (Date.now() - start >= graceMs) return checks; // still 0 after grace — caller decides (treat as no checks)
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
}
