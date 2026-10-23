#!/usr/bin/env node
import { startFakeGitHubApi, DEFAULT_FAKE_GITHUB_PORT } from "../src/fake-github.js";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(
            `Local fake GitHub API for agent-actions-await\n\nUsage:\n  npm run fake:github -- [--port ${DEFAULT_FAKE_GITHUB_PORT}]\n\nKeep this running, configure the MCP example in examples/mcp.fake-github.json, then trigger a scenario:\n  curl -X POST http://127.0.0.1:${DEFAULT_FAKE_GITHUB_PORT}/__fake/scenario -H 'content-type: application/json' -d '{"action":"fail"}'\n\nActions: pass, fail, push, comment, review, close, reopen, reset\n`,
        );
        return;
    }
    let port = DEFAULT_FAKE_GITHUB_PORT;
    if (args.length) {
        if (args.length !== 2 || args[0] !== "--port") throw new Error("use --help for usage");
        port = Number(args[1]);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
            throw new Error("--port must be between 0 and 65535");
    }
    const api = await startFakeGitHubApi({ port });
    process.stdout.write(`Fake GitHub API listening at ${api.url}\n`);
    process.stdout.write("Test PR: owner=acme, repo=demo, pr_number=42\n");
    process.stdout.write(
        `Trigger actions with POST ${api.url}/__fake/scenario, JSON {"action":"pass|fail|push|comment|review|close|reopen|reset"}\n`,
    );
    const shutdown = () => api.server.close(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
