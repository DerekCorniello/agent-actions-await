export function usageText(): string {
    return `agent-actions-await — MCP server to wait on GitHub PR checks

Usage:
  npx -y agent-actions-await

Invoked via harness only. Add once:

  claude mcp add agent-actions-await -- npx -y agent-actions-await

The server auto-creates config from git remote on first run.

Options:
  --polling-only  Start without webhook setup or a tunnel
  --poll-interval-seconds N  Override fallback poll interval (1-3600)
  --poll-grace-seconds N  Override fallback startup delay (0-3600)
  doctor         Report GitHub auth availability and configured webhook mode
  --help  Show this help
`;
}

export const GITHUB_WEBHOOK_EVENTS = [
    "check_suite",
    "check_run",
    "workflow_run",
    "pull_request",
    "status",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review",
] as const;

export function buildHookPayload(hookUrl: string, secret: string): string {
    return JSON.stringify({
        config: { url: hookUrl, content_type: "json", secret, insecure_ssl: "0" },
        events: [...GITHUB_WEBHOOK_EVENTS],
        active: true,
    });
}
