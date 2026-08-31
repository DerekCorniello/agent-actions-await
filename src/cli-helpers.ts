export function usageText(): string {
    return `agent-actions-await — MCP server to wait on GitHub PR checks

Usage:
  npx -y agent-actions-await

Invoked via harness only. Add once:

  claude mcp add agent-actions-await -- npx -y agent-actions-await

The server auto-creates config from git remote on first run.

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
