# agent-actions-await

Wait on GitHub PR checks without sleeping in a loop. Your agent calls a tool, the tool waits, then returns when checks finish.

I got tired of agents doing `sleep 10 && gh pr checks` over and over. This runs a small local MCP server that listens for real GitHub webhooks and tells the agent when the PR is actually done.

## How it works

You run one process locally. It opens a quick Cloudflare tunnel, registers a GitHub webhook to that tunnel URL, and holds an in-memory bus keyed by `owner/repo@sha`. When GitHub posts `check_run` or `workflow_run` events, the server normalizes them and resolves the waiting tool call. If webhooks get dropped, it polls the GitHub API on a backoff instead. No hosted service. No extra accounts. You run it, you own it.

## Setup — one command if you are in a git repo

```sh
npx agent-actions-await setup
# or: npx agent-actions-await init
# or: npx agent-actions-await init owner/repo
```

`setup` is the same as `init` then prints the line to copy for your harness. With no arg it reads `git remote get-url origin` so you do not have to type `owner/repo`. If you skip `init` entirely, `start` will auto-detect the repo and init for you.

`init` does three things:

- creates a per-repo webhook secret in `~/.config/agent-actions-await/secrets/owner__repo.txt` with 600 perms
- tries `gh api repos/owner/repo/hooks` if `gh` is logged in, else prints the URL and secret so you can add the hook by hand. Poll fallback works even without a hook, so you can use it right away and add the webhook later.
- writes `~/.config/agent-actions-await/config.json` with the repo and port. Run `npx agent-actions-await doctor` to see what is configured, whether `gh` is authed, and whether `cloudflared` is cached.

`start`:

- picks a free port on `127.0.0.1`, starts the webhook receiver at `POST /webhook` and `GET /health`
- starts or reuses a `cloudflared` quick tunnel and exposes the webhook, starts a fallback poller (30s grace, then every 15s)
- connects an MCP server over stdio with three tools. If no config exists it auto-inits from git remote first.

Polling and GH host are configurable globally and per call. It works with `github.com` and GitHub Enterprise via `GITHUB_API_URL` or `GH_HOST`.

## MCP tools

This exposes two ways to use the same watch, plus a convenience wrapper.

- `start_pr_watch(owner, repo, pr_number, filter, timeout_seconds)` returns a `handle` right away. This is the default you should use. It works on any transport, including the 2026-07-28 stateless spec.
- `get_pr_watch_status(handle)` returns `pending`, `completed`, or `timed_out` with per-check results. The handle stays until you read the final state once, then it is removed after a short grace. This keeps the API stateless per call.
- `await_pr_actions(owner, repo, pr_number, filter, timeout_seconds)` starts the same watch but holds the request open until it finishes. Useful if your harness likes one call. It sends progress notifications when the client supports them, otherwise it just returns at the end.

Filter is an exact check name or list of names, or `all`. I chose exact match on purpose. Regex was tempting but it hid mistakes, so we kept it simple.

If the PR gets a new push while you wait, the watch resets to the new `sha` and refetches checks. If the PR is closed or merged, it completes right away.

## Connect a client — one line per harness

```sh
claude mcp add agent-actions-await -- npx -y agent-actions-await start --stdio
# or for opencode / codex / cursor — same shape, or copy examples/mcp.json
```

Stdio is the safest bet. If your harness uses a file, add this to `mcp.json` or `claude.json`:

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

`examples/mcp.json` has the same. After `setup`, just run the `claude mcp add ...` line it prints and you are done.

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
