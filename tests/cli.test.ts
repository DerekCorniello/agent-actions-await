import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cli", () => {
    it("bin/cli.ts builds to executable and --help prints usage", () => {
        const out = execFileSync("node", ["dist/bin/cli.js", "--help"], { encoding: "utf8" });
        expect(out).toMatch(/agent-actions-await/);
        expect(out).toMatch(/claude mcp add/);
    });

    it("dist/bin/cli.js exists and is executable", () => {
        expect(existsSync("dist/bin/cli.js")).toBe(true);
    });

    it("help mentions harness add", () => {
        const out = execFileSync("node", ["dist/bin/cli.js", "--help"], { encoding: "utf8" });
        expect(out).toMatch(/MCP server to wait on GitHub PR checks/);
    });

    it("doctor reports auth and webhook mode without creating config or exposing secrets", () => {
        const dir = mkdtempSync(join(tmpdir(), "aaw-doctor-"));
        try {
            const secret = "do-not-print-this-secret";
            const configDir = join(dir, "agent-actions-await");
            mkdirSync(configDir);
            writeFileSync(
                join(configDir, "config.json"),
                JSON.stringify({
                    repos: [
                        { owner: "acme", repo: "demo", hookId: 17, secretPath: secret },
                        { owner: "acme", repo: "other", secretPath: secret },
                    ],
                }),
            );
            const out = execFileSync("node", ["dist/bin/cli.js", "doctor"], {
                encoding: "utf8",
                env: { ...process.env, XDG_CONFIG_HOME: dir, GITHUB_TOKEN: "token-value" },
            });
            expect(out).toContain("GitHub auth: environment token available");
            expect(out).toContain("webhooks configured for 1 of 2 repositories");
            expect(out).not.toContain(secret);
            expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual({
                repos: [
                    { owner: "acme", repo: "demo", hookId: 17, secretPath: secret },
                    { owner: "acme", repo: "other", secretPath: secret },
                ],
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("polling-only keeps stdout clear for MCP and exits cleanly on stdin EOF", async () => {
        const dir = mkdtempSync(join(tmpdir(), "aaw-polling-"));
        try {
            const child = spawn("node", ["dist/bin/cli.js", "--polling-only"], {
                env: { ...process.env, XDG_CONFIG_HOME: dir },
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                stdout += chunk;
            });
            let stderr = "";
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
                stderr += chunk;
            });
            child.stdin.end();
            const status = await new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", resolve);
            });
            expect(status).toBe(0);
            expect(stdout).toBe("");
            expect(stderr).toContain("MCP stdio connected");
            expect(existsSync(join(dir, "agent-actions-await", "config.json"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
