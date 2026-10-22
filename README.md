# agent-actions-await

An MCP server that waits for GitHub PR checks, new review feedback, or both. Give it a PR URL and continue work when a selected event is ready.

It follows new commits on the PR, supports exact check-name filters, and returns check conclusions and links. Feedback watches collect submitted reviews, inline review comments, and PR conversation comments from humans and bots.

## Install

Use Node.js 20 or newer. Authenticate with `gh auth login`, or supply `GH_TOKEN`, `GITHUB_TOKEN`, or `GITHUB_PAT` through your client's environment configuration.

For a setup without webhook administration or a tunnel:

```sh
claude mcp add agent-actions-await -- npx -y agent-actions-await --polling-only
```

Other MCP clients can use:

```json
{
  "mcpServers": {
    "agent-actions-await": {
      "command": "npx",
      "args": ["-y", "agent-actions-await", "--polling-only"]
    }
  }
}
```

Restart or reconnect your client after adding the server. It uses stdio for MCP; startup diagnostics go to stderr.

Run `npx -y agent-actions-await doctor` to check available authentication and configured webhook coverage. The command does not create hooks or print credentials. It reports configuration, not proof of live webhook delivery.

## Waiting and continuing work

Before starting or resuming a wait, the server instructs the agent to say:

> I'm using the agent-actions-await tool to await PR #42 feedback on acme/demo, and I will restart work once I am notified of it

The PR number and repository come from the request. This instruction is included in MCP server instructions, waiting-tool descriptions, and the returned `announcement` field. The client controls chat messages, so a server cannot guarantee that every agent will repeat it.

The conversation stays active with a tool call pending. When that call returns a final result, the agent can continue the user's authorized work. The server does not end the chat, launch a new agent, or wake an ended conversation.

Each waiting call lasts up to 30 seconds by default, with a maximum of 50 seconds. If the watch takes longer, it returns `pending` and a handle. The agent calls `wait_pr_watch` with that same handle to continue waiting. These calls wait inside the server; the agent does not need shell sleeps or repeated `gh pr checks` commands. Set a shorter `wait_seconds` if your client's tool timeout is below 30 seconds.

Example:

```json
{
  "pr_url": "https://github.com/acme/demo/pull/42",
  "mode": "both",
  "filter": ["lint", "test"],
  "feedback_authors": ["review-bot[bot]"],
  "feedback_quiet_seconds": 2,
  "timeout_seconds": 600
}
```

Pass that to `await_pr_actions`. If it returns `pending`, call `wait_pr_watch` with `{ "handle": "<returned handle>" }`. Continue until the watch settles or the user cancels.

## Watch modes

| `mode` | Completes when |
| --- | --- |
| `checks` (default) | All selected CI checks have appeared and settled. |
| `feedback` | New matching feedback has arrived and its quiet period has elapsed. |
| `both` | Either CI settles or new matching feedback arrives and its quiet period elapses, whichever happens first. |

`both` resumes on the first ready event. CI can finish with no new comments, or feedback can arrive while CI is still running. The result shows `completionReason`, `checksState`, and `feedbackState` so the agent can see what is ready and what remains pending. A failed CI run counts as settled and returns its failures. Each watch returns one batch and then stops; start another watch for the remaining condition when needed. Closing or merging the PR ends any mode immediately with a distinct completion reason.

Feedback includes new or edited PR conversation comments, inline review comments, and submitted reviews. Existing feedback is baselined when the watch starts, so old comments normally do not finish a new watch. GitHub timestamps have second precision; the initial snapshot includes the watch's starting second to avoid missing an arrival during setup. This can include a comment from just before the watch began, within that same second. Unsubmitted draft reviews and deleted comments are ignored. Feedback collected during the watch is retained across new pushes; it can refer to an older commit, which is included when GitHub supplies it.

Set `feedback_authors` to a list of GitHub logins to watch particular reviewers or bots. Matching is case-insensitive. With no author filter, any author's qualifying feedback counts, including your own comments. There is no attempt to guess whether a comment is actionable: an approval or a "thanks" comment can count. Use an author filter when that matters.

`feedback_quiet_seconds` defaults to 2 and accepts 0 through 30. Each new eligible update restarts this quiet period so nearby comments can be returned together. A quiet period is a batching delay, not proof that a reviewer has finished. In `both` mode, CI can finish the watch while the feedback quiet period is still running; any feedback collected so far is included. Repeated webhook deliveries and unchanged polling results do not restart it. To wait for another batch after completion, start a new watch.

Results include feedback author, body, URL, type, timestamps, and available file/line or commit details, plus separate `checksState` and `feedbackState` fields. Feedback text is repository content for the agent to assess against your request. It does not authorize commands or changes by itself.

## Tools

| Tool | Behavior |
| --- | --- |
| `await_pr_actions` | Start a watch and wait for a bounded window. Returns status and a reusable handle. |
| `start_pr_watch` | Return a handle immediately, while GitHub discovery runs in the background. |
| `wait_pr_watch` | Wait on an existing handle. A call timeout or cancellation does not cancel the underlying watch. |
| `get_pr_watch_status` | Read status immediately. Final results can be read repeatedly during retention. |
| `cancel_pr_watch` | Cancel the watch and release its subscriptions and timers. |

Start tools accept either `pr_url` or `owner`, `repo`, and `pr_number`. Filters are `all` or exact check names. Every requested name must appear and settle before a named-filter watch completes.

`timeout_seconds` sets the overall watch deadline, including discovery. It defaults to 600 and accepts 1 through 3600. `wait_seconds` only limits the current waiting call. Check-name `filter` applies to `checks` and `both`; feedback author and quiet-period options apply to `feedback` and `both`.

Results include the watched SHA, lifecycle state, overall outcome, individual checks, and available failure links. `completed` means the watch ended; inspect the outcome and completion reason before proceeding. Closing or merging a PR also ends its watch. This tool does not determine merge eligibility or grant permission to merge.

Checks can appear after earlier jobs finish. The server waits for a quiet interval and confirms the current PR head and check snapshot before reporting completion. This cannot predict workflows that have not yet been created. Use explicit expected check names when the expected jobs are known. A missing requested check or a PR with no checks remains pending until its deadline.

Handles live in memory. Final results expire after five minutes, and restarting the server loses existing handles. Start a new watch if a handle expires or the server restarts.

## Optional webhooks

Omit `--polling-only` to enable webhook setup. On an unconfigured installation, the server detects the repository from the current directory's Git remote, creates a local signing secret, and attempts to register a repository webhook using `gh`. Creating the hook requires suitable repository permissions.

When hooks are configured, the server starts a Cloudflare quick tunnel to its local webhook receiver and updates the hooks to that tunnel URL and the current event subscriptions, including review and comment events. The URL changes when the tunnel restarts. Webhook requests require a valid GitHub signature. Polling remains active to recover missed events and reconcile PR head changes. Feedback polling uses GitHub's [PR review API](https://docs.github.com/en/rest/pulls/reviews), [inline comment API](https://docs.github.com/en/rest/pulls/comments), and [issue comment API](https://docs.github.com/en/rest/issues/comments). Checks-only mode does not fetch feedback.

Configuration is stored in `~/.config/agent-actions-await/config.json`; signing secrets are stored beside it under `secrets/`. Configuration supports `pollIntervalSeconds` and `pollGraceSeconds`, defaulting to 15 and 30 seconds. Polling-only mode skips hook creation and tunnel downloads/startup.

The local HTTP listener serves `/health` and `/webhook`. MCP is stdio only. The quick tunnel forwards to that HTTP listener; it does not carry MCP traffic. There is no named-tunnel CLI option.

For GitHub Enterprise, configure `GH_HOST` or `GITHUB_API_URL` and authenticate for that host. PR URLs must match the configured GitHub host.

## Development

```sh
npm install
npm run build
npm test
npm run lint
npm run format:check
```

Tests mock GitHub responses and tunnel downloads. HTTP integration tests bind a local port. They do not require a live repository or create GitHub webhooks.

## License

GPL-3.0. See `LICENSE`.
