import { describe, it, expect } from "vitest";
import { usageText, buildHookPayload, GITHUB_WEBHOOK_EVENTS } from "../src/cli-helpers.js";

describe("cli-helpers", () => {
    it("usageText contains harness add", () => {
        const t = usageText();
        expect(t).toMatch(/agent-actions-await/);
        expect(t).toMatch(/claude mcp add/);
        expect(t).toMatch(/--help/);
    });

    it("buildHookPayload is valid JSON with all CI and feedback events", () => {
        const p = JSON.parse(buildHookPayload("https://x.trycloudflare.com/webhook", "sec123")) as {
            config: { url: string; secret: string };
            events: string[];
        };
        expect(p.config.url).toBe("https://x.trycloudflare.com/webhook");
        expect(p.config.secret).toBe("sec123");
        expect(p.events).toEqual([
            "check_suite",
            "check_run",
            "workflow_run",
            "pull_request",
            "status",
            "issue_comment",
            "pull_request_review_comment",
            "pull_request_review",
        ]);
        expect(p.events).toEqual([...GITHUB_WEBHOOK_EVENTS]);
    });
});
