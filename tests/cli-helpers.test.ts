import { describe, it, expect } from "vitest";
import { usageText, buildHookPayload } from "../src/cli-helpers.js";

describe("cli-helpers", () => {
    it("usageText contains harness add", () => {
        const t = usageText();
        expect(t).toMatch(/agent-actions-await/);
        expect(t).toMatch(/claude mcp add/);
        expect(t).toMatch(/--help/);
    });

    it("buildHookPayload is valid JSON with 5 events and secret", () => {
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
        ]);
    });
});
