import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventBus, NormalizedEvent } from "./bus.js";

export const MAX_PAYLOAD_BYTES = 1_000_000;
export const DEDUP_TTL_MS = 5 * 60 * 1000;

/**
 * Verify X-Hub-Signature-256. Returns true if valid.
 * Uses timingSafeEqual as required by Q26.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
): boolean {
  if (!signatureHeader) return false;
  // Header format: sha256=<hex>
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedWithPrefix = prefix + expected;
  // timingSafeEqual requires same length buffers
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expectedWithPrefix);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function computeSignature(secret: string, rawBody: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * In-memory dedup cache for X-GitHub-Delivery IDs (Q26 replay protection)
 */
export class DeliveryDedup {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEDUP_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  isDuplicate(deliveryId: string): boolean {
    const now = Date.now();
    // GC expired
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
    if (this.seen.has(deliveryId)) return true;
    this.seen.set(deliveryId, now + this.ttlMs);
    return false;
  }

  clear(): void {
    this.seen.clear();
  }

  size(): number {
    return this.seen.size;
  }
}

export type WebhookParseResult = {
  events: NormalizedEvent[];
  ignoredReason?: string;
};

/**
 * Normalize GitHub webhook JSON payloads into internal events.
 * Handles 5 event types per Q28: check_suite, check_run, workflow_run, pull_request, status (commit_status).
 * Returns 0 or more events (workflow_run may map to 1, status to 1, etc.).
 */
export function normalizePayload(
  eventType: string,
  payload: unknown,
): WebhookParseResult {
  try {
    const p = payload as Record<string, unknown>;
    switch (eventType) {
      case "check_run":
        return normalizeCheckRun(p);
      case "check_suite":
        return normalizeCheckSuite(p);
      case "workflow_run":
        return normalizeWorkflowRun(p);
      case "pull_request":
        return normalizePullRequest(p);
      case "status":
        return normalizeStatus(p);
      default:
        return { events: [], ignoredReason: `unsupported event type: ${eventType}` };
    }
  } catch (e) {
    return { events: [], ignoredReason: `parse error: ${(e as Error).message}` };
  }
}

function repoInfo(repo: unknown): { owner: string; repo: string } | null {
  const r = repo as Record<string, unknown> | undefined;
  if (!r) return null;
  const owner = (r.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  // fallback: r.full_name "o/r"
  if (!owner && typeof r.full_name === "string") {
    const parts = (r.full_name as string).split("/");
    if (parts.length === 2) return { owner: parts[0]!, repo: parts[1]! };
  }
  const name = r.name as string | undefined;
  if (owner && name) return { owner, repo: name };
  return null;
}

function normalizeCheckRun(p: Record<string, unknown>): WebhookParseResult {
  const cr = p.check_run as Record<string, unknown> | undefined;
  const repo = repoInfo(p.repository);
  if (!cr || !repo) return { events: [], ignoredReason: "missing check_run or repository" };
  const sha = (cr.head_sha as string | undefined) ?? (cr.head_sha as unknown as string);
  if (!sha) return { events: [], ignoredReason: "missing head_sha" };
  const evt: NormalizedEvent = {
    owner: repo.owner,
    repo: repo.repo,
    sha,
    type: "check_run",
    status: (cr.status as string) ?? "unknown",
    conclusion: (cr.conclusion as string | null) ?? null,
    name: (cr.name as string) ?? "unknown",
    raw: p,
  };
  return { events: [evt] };
}

function normalizeCheckSuite(p: Record<string, unknown>): WebhookParseResult {
  const cs = p.check_suite as Record<string, unknown> | undefined;
  const repo = repoInfo(p.repository);
  if (!cs || !repo) return { events: [], ignoredReason: "missing check_suite or repository" };
  const sha = cs.head_sha as string | undefined;
  if (!sha) return { events: [], ignoredReason: "missing head_sha" };
  // check_suite has multiple check_runs; normalize as one suite-level event for completeness
  const evt: NormalizedEvent = {
    owner: repo.owner,
    repo: repo.repo,
    sha,
    type: "check_suite",
    status: (cs.status as string) ?? "unknown",
    conclusion: (cs.conclusion as string | null) ?? null,
    name: `check_suite:${(cs.app as Record<string, unknown> | undefined)?.slug ?? "unknown"}`,
    raw: p,
  };
  return { events: [evt] };
}

function normalizeWorkflowRun(p: Record<string, unknown>): WebhookParseResult {
  const wr = p.workflow_run as Record<string, unknown> | undefined;
  const repo = repoInfo(p.repository);
  if (!wr || !repo) return { events: [], ignoredReason: "missing workflow_run or repository" };
  const sha = wr.head_sha as string | undefined;
  if (!sha) return { events: [], ignoredReason: "missing head_sha" };
  const evt: NormalizedEvent = {
    owner: repo.owner,
    repo: repo.repo,
    sha,
    type: "workflow_run",
    status: (wr.status as string) ?? "unknown",
    conclusion: (wr.conclusion as string | null) ?? null,
    name: (wr.name as string) ?? (wr.workflow_id as string) ?? "workflow_run",
    raw: p,
  };
  return { events: [evt] };
}

function normalizePullRequest(p: Record<string, unknown>): WebhookParseResult {
  const pr = p.pull_request as Record<string, unknown> | undefined;
  const repo = repoInfo(p.repository);
  if (!pr || !repo) return { events: [], ignoredReason: "missing pull_request or repository" };
  const head = pr.head as Record<string, unknown> | undefined;
  const sha = head?.sha as string | undefined;
  if (!sha) return { events: [], ignoredReason: "missing head.sha" };
  const evt: NormalizedEvent = {
    owner: repo.owner,
    repo: repo.repo,
    sha,
    type: "pull_request",
    status: (p.action as string) ?? "unknown",
    conclusion: null,
    name: `pr:${(pr.number as number | undefined) ?? "unknown"}`,
    raw: p,
  };
  return { events: [evt] };
}

function normalizeStatus(p: Record<string, unknown>): WebhookParseResult {
  const repo = repoInfo(p.repository);
  if (!repo) return { events: [], ignoredReason: "missing repository" };
  const sha = p.sha as string | undefined;
  if (!sha) return { events: [], ignoredReason: "missing sha" };
  const state = p.state as string | undefined;
  const context = p.context as string | undefined;
  // Map legacy Status API state to conclusion-ish
  const status = state === "pending" ? "pending" : "completed";
  const conclusion = state === "pending" ? null : state; // success/failure/error
  const evt: NormalizedEvent = {
    owner: repo.owner,
    repo: repo.repo,
    sha,
    type: "status",
    status,
    conclusion: conclusion ?? null,
    name: context ?? "status",
    raw: p,
  };
  return { events: [evt] };
}

/**
 * Minimal webhook HTTP handler for Node's http.IncomingMessage / ServerResponse.
 * Validates HMAC, enforces 1MB cap, dedups delivery ID, normalizes and publishes to bus.
 * Returns status code semantics; caller writes response.
 *
 * getSecret(owner, repo) -> secret string | undefined (per-repo file Q5+Q34). If undefined, reject with 500 hint.
 */
export type WebhookHandlerOpts = {
  bus: EventBus;
  getSecret: (owner: string, repo: string) => string | undefined;
  dedup?: DeliveryDedup;
  maxBytes?: number;
};

export async function handleWebhookRequest(
  req: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  },
  rawBody: Buffer,
  opts: WebhookHandlerOpts,
): Promise<{ status: number; body: string; events: NormalizedEvent[] }> {
  const { bus, getSecret, dedup, maxBytes = MAX_PAYLOAD_BYTES } = opts;

  if (req.method !== "POST") {
    return { status: 405, body: "method not allowed", events: [] };
  }

  const h = (name: string): string | undefined => {
    const v = req.headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  const eventType = h("x-github-event");
  const deliveryId = h("x-github-delivery");
  const signature = h("x-hub-signature-256");

  if (!eventType) return { status: 400, body: "missing X-GitHub-Event", events: [] };

  if (rawBody.length > maxBytes) {
    return { status: 413, body: "payload too large", events: [] };
  }

  if (deliveryId && dedup?.isDuplicate(deliveryId)) {
    // replay / retry from GitHub — ack but don't re-publish (Q26)
    return { status: 200, body: "duplicate delivery ignored", events: [] };
  }

  // Need repository info to look up per-repo secret — require parsing first without verification?
  // Instead we require parsing to get owner/repo, then lookup secret, then verify.
  // If we can't parse owner/repo, fall back to requiring any secret? For security we verify before publish,
  // but we need secret to verify. So try to extract owner/repo from payload lightly.
  let provisional: { owner?: string; repo?: string } = {};
  try {
    const j = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const ri = repoInfo(j.repository);
    if (ri) provisional = ri;
    // Also need event to contain repo; if not, can't verify per-repo — reject
    if (!ri) {
      return { status: 400, body: "missing repository in payload", events: [] };
    }
    const secret = getSecret(ri.owner, ri.repo);
    if (!secret) {
      return { status: 500, body: `no webhook secret configured for ${ri.owner}/${ri.repo}`, events: [] };
    }
    if (!verifySignature(secret, rawBody, signature)) {
      return { status: 401, body: "invalid signature", events: [] };
    }
    const parsed = normalizePayload(eventType, j);
    if (parsed.events.length === 0 && parsed.ignoredReason) {
      // still 200 for unsupported events to avoid GitHub retry storm
      return { status: 200, body: `ignored: ${parsed.ignoredReason}`, events: [] };
    }
    for (const e of parsed.events) bus.publish(e);
    return { status: 200, body: "ok", events: parsed.events };
  } catch {
    return { status: 400, body: "invalid json", events: [] };
  }
}
