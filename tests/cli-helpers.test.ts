import { describe, it, expect } from "vitest";
import {
    parseOwnerRepo,
    usageText,
    buildHookPayload,
    parsePortArg,
    shouldUseStdio,
} from "../src/cli-helpers.js";

describe("cli-helpers", () => {
    it("parseOwnerRepo splits owner/repo", () => {
        expect(parseOwnerRepo("acme/demo")).toEqual({ owner: "acme", repo: "demo" });
    });

    it("parseOwnerRepo throws on bad input", () => {
        expect(() => parseOwnerRepo("bad")).toThrow(/expected/);
        expect(() => parseOwnerRepo("a/")).toThrow();
        expect(() => parseOwnerRepo("/b")).toThrow();
    });

    it("usageText contains init and start", () => {
        const t = usageText();
        expect(t).toMatch(/init/);
        expect(t).toMatch(/start/);
        expect(t).toMatch(/--port/);
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

    it("parsePortArg returns number or undefined", () => {
        expect(parsePortArg([])).toBeUndefined();
        expect(parsePortArg(["--port", "3000"])).toBe(3000);
        expect(parsePortArg(["--port", "0"])).toBe(0);
        expect(() => parsePortArg(["--port", "bad"])).toThrow(/requires a number/);
        expect(parsePortArg(["--port"])).toBeUndefined();
    });

    it("shouldUseStdio respects --http-only", () => {
        expect(shouldUseStdio([])).toBe(true);
        expect(shouldUseStdio(["--http-only"])).toBe(false);
        expect(shouldUseStdio(["--port", "3000"])).toBe(true);
    });
});
