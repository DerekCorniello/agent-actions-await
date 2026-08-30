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

export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_PAT ?? undefined;
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
  return c.status === "completed" || c.status === "success" || c.status === "failure" || c.status === "error" || c.conclusion !== null;
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
export async function getPrHeadSha(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  auth?: GhAuth;
  fetchFn?: FetchFn;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const apiBase = opts.auth?.apiBase ?? resolveApiBase(opts.env);
  const token = opts.auth?.token ?? resolveToken(opts.env);
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
    throw new Error(`getPrHeadSha ${opts.owner}/${opts.repo}#${opts.prNumber} failed ${res.status}: ${body}`);
  }
  const j = (await res.json()) as { head: { sha: string } };
  if (!j.head?.sha) throw new Error("getPrHeadSha: missing head.sha in response");
  return j.head.sha;
}

/**
 * Fetch checks for a SHA. Combines check-runs + commit statuses for Q28 coverage.
 * Returns normalized CheckInfo[].
 */
export async function getChecksForSha(opts: {
  owner: string;
  repo: string;
  sha: string;
  auth?: GhAuth;
  fetchFn?: FetchFn;
  env?: NodeJS.ProcessEnv;
}): Promise<CheckInfo[]> {
  const apiBase = opts.auth?.apiBase ?? resolveApiBase(opts.env);
  const token = opts.auth?.token ?? resolveToken(opts.env);
  const ff = opts.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Check-runs for SHA
  const crUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/check-runs`;
  const crRes = await fetchWithBackoff(crUrl, { headers }, ff);
  let checkRuns: CheckInfo[] = [];
  if (crRes.ok) {
    const j = (await crRes.json()) as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> };
    checkRuns = (j.check_runs ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      sha: opts.sha,
    }));
  } else if (crRes.status !== 404) {
    const body = await crRes.text().catch(() => "");
    throw new Error(`getChecksForSha check-runs failed ${crRes.status}: ${body}`);
  }

  // Commit statuses (legacy) for completeness
  const stUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/status`;
  const stRes = await fetchWithBackoff(stUrl, { headers }, ff);
  let statuses: CheckInfo[] = [];
  if (stRes.ok) {
    const j = (await stRes.json()) as { statuses: Array<{ context: string; state: string }>; state: string };
    // For combined status, each individual status is a CheckInfo
    statuses = (j.statuses ?? []).map((s) => ({
      name: s.context,
      status: s.state === "pending" ? "pending" : "completed",
      conclusion: s.state === "pending" ? null : s.state,
      sha: opts.sha,
    }));
  }
  return [...checkRuns, ...statuses];
}

/**
 * Grace for creation race (Q21): if 0 checks, poll again up to graceMs or until at least one appears.
 * Uses pollIntervalMs between attempts.
 */
export async function getChecksForShaWithGrace(opts: {
  owner: string;
  repo: string;
  sha: string;
  auth?: GhAuth;
  fetchFn?: FetchFn;
  env?: NodeJS.ProcessEnv;
  graceMs?: number;
  pollIntervalMs?: number;
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
