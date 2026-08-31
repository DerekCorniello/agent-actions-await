import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
    verifySignature,
    computeSignature,
    normalizePayload,
    handleWebhookRequest,
    DeliveryDedup,
    MAX_PAYLOAD_BYTES,
} from "../src/webhook.js";
import { EventBus } from "../src/bus.js";

const SECRET = "test-secret-32-bytes-long-xxxxxx";

function sig(body: Buffer): string {
    return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function makePayload(
    repoOwner = "acme",
    repoName = "demo",
    overrides: Record<string, unknown> = {},
) {
    return {
        repository: {
            owner: { login: repoOwner },
            name: repoName,
            full_name: `${repoOwner}/${repoName}`,
        },
        ...overrides,
    };
}

describe("verifySignature", () => {
    it("accepts valid signature with timingSafeEqual", () => {
        const body = Buffer.from(JSON.stringify({ a: 1 }));
        const s = computeSignature(SECRET, body);
        expect(verifySignature(SECRET, body, s)).toBe(true);
    });

    it("rejects invalid signature", () => {
        const body = Buffer.from("hello");
        expect(
            verifySignature(
                SECRET,
                body,
                "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad",
            ),
        ).toBe(false);
    });

    it("rejects missing header", () => {
        expect(verifySignature(SECRET, Buffer.from("x"), null)).toBe(false);
    });

    it("rejects wrong prefix", () => {
        expect(verifySignature(SECRET, Buffer.from("x"), "sha1=abc")).toBe(false);
    });

    it("rejects length-mismatch without timing leak", () => {
        const body = Buffer.from("hi");
        const s = sig(body);
        expect(verifySignature(SECRET, body, s + "00")).toBe(false);
    });
});

describe("normalizePayload", () => {
    it("normalizes check_run", () => {
        const payload = makePayload("acme", "demo", {
            check_run: {
                head_sha: "sha123",
                status: "completed",
                conclusion: "success",
                name: "ci",
            },
        });
        const r = normalizePayload("check_run", payload);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({
            owner: "acme",
            repo: "demo",
            sha: "sha123",
            type: "check_run",
            conclusion: "success",
        });
    });

    it("normalizes check_suite", () => {
        const payload = makePayload("acme", "demo", {
            check_suite: {
                head_sha: "sha999",
                status: "completed",
                conclusion: "success",
                app: { slug: "github-actions" },
            },
        });
        const r = normalizePayload("check_suite", payload);
        expect(r.events[0]!.type).toBe("check_suite");
        expect(r.events[0]!.name).toBe("check_suite:github-actions");
    });

    it("normalizes workflow_run", () => {
        const payload = makePayload("acme", "demo", {
            workflow_run: {
                head_sha: "wsha",
                status: "completed",
                conclusion: "success",
                name: "CI",
            },
        });
        const r = normalizePayload("workflow_run", payload);
        expect(r.events[0]!).toMatchObject({ type: "workflow_run", name: "CI" });
    });

    it("normalizes pull_request (synchronized) as sha event", () => {
        const payload = makePayload("acme", "demo", {
            action: "synchronize",
            pull_request: { number: 42, head: { sha: "prsha" } },
        });
        const r = normalizePayload("pull_request", payload);
        expect(r.events[0]!).toMatchObject({ type: "pull_request", sha: "prsha", name: "pr:42" });
    });

    it("normalizes status (legacy)", () => {
        const payload = makePayload("acme", "demo", {
            sha: "statsha",
            state: "pending",
            context: "ci/legacy",
        });
        const r = normalizePayload("status", payload);
        expect(r.events[0]!).toMatchObject({
            type: "status",
            status: "pending",
            name: "ci/legacy",
            conclusion: null,
        });
    });

    it("returns ignored for unsupported event", () => {
        const r = normalizePayload("issues", {});
        expect(r.events).toHaveLength(0);
        expect(r.ignoredReason).toMatch(/unsupported/);
    });

    it("handles repository full_name fallback", () => {
        const payload = {
            repository: { full_name: "foo/bar" },
            check_run: { head_sha: "s", status: "completed", conclusion: "success", name: "x" },
        };
        const r = normalizePayload("check_run", payload);
        expect(r.events[0]!.owner).toBe("foo");
        expect(r.events[0]!.repo).toBe("bar");
    });
});

describe("handleWebhookRequest", () => {
    it("rejects invalid signature with 401", async () => {
        const bus = new EventBus();
        const body = Buffer.from(
            JSON.stringify(
                makePayload("acme", "demo", {
                    check_run: {
                        head_sha: "a",
                        status: "completed",
                        conclusion: "success",
                        name: "ci",
                    },
                }),
            ),
        );
        const res = await handleWebhookRequest(
            {
                method: "POST",
                headers: {
                    "x-github-event": "check_run",
                    "x-hub-signature-256": "sha256=bad",
                    "x-github-delivery": "d1",
                },
                url: "/webhook",
            },
            body,
            { bus, getSecret: () => SECRET },
        );
        expect(res.status).toBe(401);
        expect(bus.listenerCount("acme", "demo", "a")).toBe(0);
    });

    it("enforces 1MB payload cap with 413", async () => {
        const bus = new EventBus();
        const big = Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61);
        const res = await handleWebhookRequest(
            {
                method: "POST",
                headers: {
                    "x-github-event": "check_run",
                    "x-hub-signature-256": sig(big),
                    "x-github-delivery": "d2",
                },
                url: "/webhook",
            },
            big,
            { bus, getSecret: () => SECRET, maxBytes: MAX_PAYLOAD_BYTES },
        );
        expect(res.status).toBe(413);
    });

    it("dedups delivery ID within TTL", async () => {
        const bus = new EventBus();
        const dedup = new DeliveryDedup(60_000);
        const payload = makePayload("acme", "demo", {
            check_run: {
                head_sha: "dedupsha",
                status: "completed",
                conclusion: "success",
                name: "ci",
            },
        });
        const body = Buffer.from(JSON.stringify(payload));
        const headers = {
            "x-github-event": "check_run",
            "x-hub-signature-256": sig(body),
            "x-github-delivery": "dup-1",
        } as Record<string, string>;
        let calls = 0;
        const unsub = bus.subscribe("acme", "demo", "dedupsha", () => calls++);
        const r1 = await handleWebhookRequest({ method: "POST", headers, url: "/webhook" }, body, {
            bus,
            getSecret: () => SECRET,
            dedup,
        });
        expect(r1.status).toBe(200);
        expect(calls).toBe(1);
        const r2 = await handleWebhookRequest({ method: "POST", headers, url: "/webhook" }, body, {
            bus,
            getSecret: () => SECRET,
            dedup,
        });
        expect(r2.status).toBe(200);
        expect(r2.body).toMatch(/duplicate/);
        expect(calls).toBe(1);
        unsub();
    });

    it("publishes normalized events to bus on valid request", async () => {
        const bus = new EventBus();
        let seen: string | null = null;
        bus.subscribe("acme", "demo", "pubsha", (e) => (seen = e.name));
        const payload = makePayload("acme", "demo", {
            check_run: {
                head_sha: "pubsha",
                status: "completed",
                conclusion: "failure",
                name: "my-check",
            },
        });
        const body = Buffer.from(JSON.stringify(payload));
        const res = await handleWebhookRequest(
            {
                method: "POST",
                headers: {
                    "x-github-event": "check_run",
                    "x-hub-signature-256": sig(body),
                    "x-github-delivery": "d-pub",
                },
                url: "/webhook",
            },
            body,
            { bus, getSecret: () => SECRET },
        );
        expect(res.status).toBe(200);
        expect(seen).toBe("my-check");
    });

    it("returns 500 if no secret configured for repo", async () => {
        const bus = new EventBus();
        const payload = makePayload("acme", "demo", {
            check_run: { head_sha: "x", status: "completed", conclusion: "success", name: "ci" },
        });
        const body = Buffer.from(JSON.stringify(payload));
        const res = await handleWebhookRequest(
            {
                method: "POST",
                headers: {
                    "x-github-event": "check_run",
                    "x-hub-signature-256": sig(body),
                    "x-github-delivery": "d3",
                },
                url: "/webhook",
            },
            body,
            { bus, getSecret: () => undefined },
        );
        expect(res.status).toBe(500);
    });

    it("rejects GET with 405", async () => {
        const bus = new EventBus();
        const res = await handleWebhookRequest(
            { method: "GET", headers: {}, url: "/webhook" },
            Buffer.from(""),
            { bus, getSecret: () => SECRET },
        );
        expect(res.status).toBe(405);
    });

    it("returns 200 ignored for unsupported event rather than 400 retry storm", async () => {
        const bus = new EventBus();
        const payload = makePayload("acme", "demo", {});
        const body = Buffer.from(JSON.stringify(payload));
        const res = await handleWebhookRequest(
            {
                method: "POST",
                headers: {
                    "x-github-event": "issues",
                    "x-hub-signature-256": sig(body),
                    "x-github-delivery": "d-iss",
                },
                url: "/webhook",
            },
            body,
            { bus, getSecret: () => SECRET },
        );
        expect(res.status).toBe(200);
        expect(res.body).toMatch(/ignored/);
    });

    it("is unauth probe safe: no secret no publish", async () => {
        const bus = new EventBus();
        let fired = false;
        bus.subscribeAll(() => (fired = true));
        const body = Buffer.from(
            JSON.stringify(
                makePayload("acme", "demo", {
                    check_run: {
                        head_sha: "x",
                        status: "completed",
                        conclusion: "success",
                        name: "ci",
                    },
                }),
            ),
        );
        await handleWebhookRequest(
            {
                method: "POST",
                headers: { "x-github-event": "check_run", "x-github-delivery": "d-probe" },
                url: "/webhook",
            },
            body,
            { bus, getSecret: () => SECRET },
        );
        expect(fired).toBe(false);
    });

    it("simulate helper path: curl-like payload with correct HMAC succeeds end-to-end (production-like)", async () => {
        // This is the path `npm run simulate` would use — build rawBody same as curl would send
        const bus = new EventBus();
        const events: string[] = [];
        bus.subscribeAll((e) => events.push(`${e.type}:${e.name}`));
        for (const et of [
            "check_run",
            "check_suite",
            "workflow_run",
            "pull_request",
            "status",
        ] as const) {
            const raw: Record<string, unknown> = makePayload("acme", "demo", {
                ...(et === "check_run"
                    ? {
                          check_run: {
                              head_sha: "sim",
                              status: "completed",
                              conclusion: "success",
                              name: "ci",
                          },
                      }
                    : {}),
                ...(et === "check_suite"
                    ? {
                          check_suite: {
                              head_sha: "sim",
                              status: "completed",
                              conclusion: "success",
                              app: { slug: "actions" },
                          },
                      }
                    : {}),
                ...(et === "workflow_run"
                    ? {
                          workflow_run: {
                              head_sha: "sim",
                              status: "completed",
                              conclusion: "success",
                              name: "CI",
                          },
                      }
                    : {}),
                ...(et === "pull_request"
                    ? { action: "opened", pull_request: { number: 1, head: { sha: "sim" } } }
                    : {}),
                ...(et === "status" ? { sha: "sim", state: "success", context: "ci/legacy" } : {}),
            });
            const body = Buffer.from(JSON.stringify(raw));
            const res = await handleWebhookRequest(
                {
                    method: "POST",
                    headers: {
                        "x-github-event": et,
                        "x-hub-signature-256": sig(body),
                        "x-github-delivery": `sim-${et}`,
                    },
                    url: "/webhook",
                },
                body,
                { bus, getSecret: () => SECRET },
            );
            expect(res.status).toBe(200);
        }
        expect(events).toHaveLength(5);
    });
});
