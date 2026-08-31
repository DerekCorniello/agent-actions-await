import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

describe("cli", () => {
    it("bin/cli.ts builds to executable and --help prints usage", () => {
        const out = execFileSync("node", ["dist/bin/cli.js", "--help"], { encoding: "utf8" });
        expect(out).toMatch(/npx agent-actions-await/);
        expect(out).toMatch(/claude mcp add/);
    });

    it("dist/bin/cli.js exists and is executable", () => {
        expect(existsSync("dist/bin/cli.js")).toBe(true);
    });

    it("unknown argument prints usage", () => {
        const out = execFileSync("node", ["dist/bin/cli.js", "bogus"], {
            encoding: "utf8",
            stdio: "pipe",
        });
        expect(out.toLowerCase()).toMatch(/npx agent-actions-await/);
    });
});
