export function parseOwnerRepo(arg: string): { owner: string; repo: string } {
    const [owner, repo] = arg.split("/");
    if (!owner || !repo) throw new Error(`expected <owner/repo> got ${arg}`);
    return { owner, repo };
}

export function usageText(): string {
    return `agent-actions-await — wait on GitHub PR checks without polling in bash

Usage:
  npx agent-actions-await init <owner/repo> [--port N]
  npx agent-actions-await start [--stdio] [--port N]

Commands:
  init  Register webhook for repo (via gh CLI if available), generate per-repo secret
  start Start tunnel + webhook receiver + MCP server (stdio default, HTTP on port)

Options:
  --help  Show this help
`;
}

export function buildHookPayload(hookUrl: string, secret: string): string {
    return JSON.stringify({
        config: { url: hookUrl, content_type: "json", secret, insecure_ssl: "0" },
        events: ["check_suite", "check_run", "workflow_run", "pull_request", "status"],
        active: true,
    });
}

export function parsePortArg(args: string[]): number | undefined {
    const idx = args.indexOf("--port");
    if (idx < 0) return undefined;
    const v = args[idx + 1];
    if (!v) return undefined;
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`--port requires a number, got ${v}`);
    return n;
}

export function shouldUseStdio(args: string[]): boolean {
    return !args.includes("--http-only");
}
