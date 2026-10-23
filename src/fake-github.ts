import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";

export const DEFAULT_FAKE_GITHUB_PORT = 4173;
export const FAKE_GITHUB_OWNER = "acme";
export const FAKE_GITHUB_REPO = "demo";
export const FAKE_GITHUB_PR = 42;
export const FAKE_GITHUB_TOKEN = "fake-github-token";
const MAX_CONTROL_BYTES = 8_192;

export type FakeScenario =
    "pass" | "fail" | "push" | "comment" | "review" | "close" | "reopen" | "reset";
type FakeCheck = {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_sha: string;
};
type FakeComment = {
    id: number;
    user: { login: string };
    body: string;
    html_url: string;
    created_at: string;
    updated_at: string;
};
type FakeReview = {
    id: number;
    user: { login: string };
    body: string;
    html_url: string;
    submitted_at: string;
    state: string;
    commit_id: string;
};
type FakeInlineComment = FakeComment & {
    path: string;
    line: number;
    commit_id: string;
    pull_request_review_id: number;
};

type FakeState = {
    sha: string;
    prState: "open" | "closed";
    merged: boolean;
    checks: FakeCheck[];
    comments: FakeComment[];
    reviews: FakeReview[];
    inlineComments: FakeInlineComment[];
    nextId: number;
};

function pendingChecks(sha: string): FakeCheck[] {
    return ["lint", "test"].map((name, index) => ({
        id: index + 1,
        name,
        status: "in_progress",
        conclusion: null,
        html_url: `https://github.com/${FAKE_GITHUB_OWNER}/${FAKE_GITHUB_REPO}/actions/runs/${100 + index}`,
        head_sha: sha,
    }));
}

function createInitialState(): FakeState {
    const sha = "fake-sha-1";
    return {
        sha,
        prState: "open",
        merged: false,
        checks: pendingChecks(sha),
        comments: [],
        reviews: [],
        inlineComments: [],
        nextId: 10,
    };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_CONTROL_BYTES) throw new Error("scenario payload too large");
        chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("scenario body must be a JSON object");
    return value as Record<string, unknown>;
}

function addComment(state: FakeState): FakeComment {
    const id = state.nextId++;
    const now = new Date().toISOString();
    const comment = {
        id,
        user: { login: "review-bot[bot]" },
        body: "Please inspect the failing case in the updated code.",
        html_url: `https://github.com/${FAKE_GITHUB_OWNER}/${FAKE_GITHUB_REPO}/pull/${FAKE_GITHUB_PR}#issuecomment-${id}`,
        created_at: now,
        updated_at: now,
    };
    state.comments.push(comment);
    return comment;
}

function addReview(state: FakeState): FakeReview {
    const id = state.nextId++;
    const now = new Date().toISOString();
    const review = {
        id,
        user: { login: "review-bot[bot]" },
        body: "Please address the error handling before merge.",
        html_url: `https://github.com/${FAKE_GITHUB_OWNER}/${FAKE_GITHUB_REPO}/pull/${FAKE_GITHUB_PR}#pullrequestreview-${id}`,
        submitted_at: now,
        state: "CHANGES_REQUESTED",
        commit_id: state.sha,
    };
    state.reviews.push(review);
    const commentId = state.nextId++;
    state.inlineComments.push({
        id: commentId,
        user: review.user,
        body: "This path does not handle an empty response.",
        html_url: `https://github.com/${FAKE_GITHUB_OWNER}/${FAKE_GITHUB_REPO}/pull/${FAKE_GITHUB_PR}#discussion_r${commentId}`,
        created_at: now,
        updated_at: now,
        path: "src/example.ts",
        line: 42,
        commit_id: state.sha,
        pull_request_review_id: id,
    });
    return review;
}

function applyScenario(state: FakeState, action: unknown): FakeState | null {
    if (
        typeof action !== "string" ||
        !["pass", "fail", "push", "comment", "review", "close", "reopen", "reset"].includes(action)
    )
        return null;
    switch (action as FakeScenario) {
        case "pass":
            state.checks = state.checks.map((check) => ({
                ...check,
                status: "completed",
                conclusion: "success",
            }));
            break;
        case "fail":
            state.checks = state.checks.map((check) => ({
                ...check,
                status: "completed",
                conclusion: check.name === "test" ? "failure" : "success",
            }));
            break;
        case "push":
            state.sha = `fake-sha-${Number(state.sha.split("-").at(-1)) + 1}`;
            state.checks = pendingChecks(state.sha);
            break;
        case "comment":
            addComment(state);
            break;
        case "review":
            addReview(state);
            break;
        case "close":
            state.prState = "closed";
            state.merged = false;
            break;
        case "reopen":
            state.prState = "open";
            state.merged = false;
            break;
        case "reset":
            return createInitialState();
    }
    return state;
}

function routeApi(pathname: string, state: FakeState): unknown | undefined {
    const base = `/repos/${FAKE_GITHUB_OWNER}/${FAKE_GITHUB_REPO}`;
    if (pathname === `${base}/pulls/${FAKE_GITHUB_PR}`) {
        return {
            number: FAKE_GITHUB_PR,
            state: state.prState,
            merged: state.merged,
            head: { sha: state.sha },
        };
    }
    if (pathname === `${base}/commits/${state.sha}/check-runs`) return { check_runs: state.checks };
    if (pathname === `${base}/commits/${state.sha}/status`)
        return { statuses: [], state: "pending" };
    if (pathname === `${base}/issues/${FAKE_GITHUB_PR}/comments`) return state.comments;
    if (pathname === `${base}/pulls/${FAKE_GITHUB_PR}/comments`) return state.inlineComments;
    if (pathname === `${base}/pulls/${FAKE_GITHUB_PR}/reviews`) return state.reviews;
    return undefined;
}

export async function startFakeGitHubApi(opts: { host?: string; port?: number } = {}): Promise<{
    server: Server;
    url: string;
    getState: () => Readonly<FakeState>;
}> {
    let state = createInitialState();
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname === "/__fake/state" && req.method === "GET") {
            sendJson(res, 200, {
                sha: state.sha,
                prState: state.prState,
                checks: state.checks,
                commentCount: state.comments.length,
                reviewCount: state.reviews.length,
                inlineCommentCount: state.inlineComments.length,
            });
            return;
        }
        if (url.pathname === "/__fake/scenario" && req.method === "POST") {
            try {
                const body = await readJson(req);
                const next = applyScenario(state, body.action);
                if (!next) {
                    sendJson(res, 400, {
                        error: "action must be pass, fail, push, comment, review, close, reopen, or reset",
                    });
                    return;
                }
                state = next;
                sendJson(res, 200, {
                    ok: true,
                    action: body.action,
                    sha: state.sha,
                    state: state.prState,
                });
            } catch (error) {
                sendJson(res, 400, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        if (req.method !== "GET") {
            sendJson(res, 405, { message: "fake GitHub API accepts GET requests only" });
            return;
        }
        const response = routeApi(url.pathname, state);
        if (response === undefined) {
            sendJson(res, 404, { message: `fake GitHub route not found: ${url.pathname}` });
            return;
        }
        sendJson(res, 200, response);
    });
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? DEFAULT_FAKE_GITHUB_PORT;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("fake GitHub server did not bind a TCP port");
    return {
        server,
        url: `http://${host}:${address.port}`,
        getState: () => state,
    };
}
