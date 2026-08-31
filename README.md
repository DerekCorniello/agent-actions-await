# agent-actions-await

Wait on GitHub PR checks without sleeping in a loop. Your agent calls a tool, the tool waits, then returns when checks finish.

I got tired of agents doing `sleep 10 && gh pr checks` over and over. This runs a small local MCP server that listens for real GitHub webhooks and tells the agent when the PR is actually done.

## How it works

You run one process locally. It opens a quick Cloudflare tunnel, registers a GitHub webhook to that tunnel URL, and holds an in-memory bus keyed by `owner/repo@sha`. When GitHub posts `check_run` or `workflow_run` events, the server normalizes them and resolves the waiting tool call. If webhooks get dropped, it polls the GitHub API on a backoff instead. No hosted service. No extra accounts. You run it, you own it.

## Setup — one harness command

```sh
claude mcp add agent-actions-await -- npx -y agent-actions-await start --stdio
```

That is it. Restart the harness and you are done. `start` on first boot auto-detects `owner/repo` from `git remote get-url origin` `src/git.ts:14`, creates `~/.config/agent-actions-await/secrets/owner__repo.txt` `600` and `config.json` `src/config.ts:29`, and tries `gh api` if logged in. Poll fallback `src/poller.ts:1` works without a hook, so it is usable right away.

`bin/cli.ts:129` on every start:

- picks a free port on `127.0.0.1`, starts `POST /webhook` and `GET /health` `src/http-server.ts:22`
- opens a `cloudflared` quick tunnel `src/tunnel-manager.ts:16` with 2s restart and re-PATCH `Q16`
- connects the MCP server over stdio

Polling and GH host are configurable globally and per call. It works with `github.com` and GitHub Enterprise via `GITHUB_API_URL` or `GH_HOST`.

## MCP tools

This exposes two ways to use the same watch, plus a convenience wrapper.

- `start_pr_watch(owner, repo, pr_number, filter, timeout_seconds)` returns a `handle` right away. This is the default you should use. It works on any transport, including the 2026-07-28 stateless spec.
- `get_pr_watch_status(handle)` returns `pending`, `completed`, or `timed_out` with per-check results. The handle stays until you read the final state once, then it is removed after a short grace. This keeps the API stateless per call.
- `await_pr_actions(owner, repo, pr_number, filter, timeout_seconds)` starts the same watch but holds the request open until it finishes. Useful if your harness likes one call. It sends progress notifications when the client supports them, otherwise it just returns at the end.

Filter is an exact check name or list of names, or `all`. I chose exact match on purpose. Regex was tempting but it hid mistakes, so we kept it simple.

If the PR gets a new push while you wait, the watch resets to the new `sha` and refetches checks. If the PR is closed or merged, it completes right away.

## Connect a client

If your harness uses a file, add this to `mcp.json`:

```json
{
    "mcpServers": {
        "agent-actions-await": {
            "command": "npx",
            "args": ["-y", "agent-actions-await", "start", "--stdio"]
        }
    }
}
```

`examples/mcp.json` has the same. `claude mcp add` and `opencode mcp add` use the same `npx -y agent-actions-await start --stdio` shape.

HTTP also works on the same local port if your harness needs it, but the tunnel only exposes `/webhook`. The MCP part stays on `127.0.0.1`.

## Quick tunnel tradeoffs

We use `cloudflared` quick tunnels by default. No account, no relay, one child process. The URL is random like `https://abc-123.trycloudflare.com` and changes when the tunnel restarts, so we patch the webhook on restart. The public URL has no auth, which is why every request must have a valid `X-Hub-Signature-256`. Rate cap is around 200 concurrent requests and there is no SLA, but for webhook traffic that is fine. If you have a Cloudflare account you can switch to a named tunnel for a stable URL. It is just a flag.

## Local testing without GitHub

You do not need a real repo to work on this. The webhook receiver can be tested with a signed `curl` payload. Build a JSON body, sign it with the local secret, and POST to `/webhook`.

```sh
npm run build
npm test
```

The unit tests mock GitHub API calls and Cloudflare downloads. For a manual loop, `npm run build` then `curl -H "X-GitHub-Event: check_run" -H "X-Hub-Signature-256: $(echo -n '<body>' | openssl dgst -sha256 -hmac <secret>)" http://127.0.0.1:<port>/webhook -d '<body>'`.

## What this is not

- Not a general GitHub API wrapper. It only waits on PR checks.
- Not a hosted relay. If you want one process to watch many repos, it can, but it is still your process.

## License

GPL-3.0. See `LICENSE`.
