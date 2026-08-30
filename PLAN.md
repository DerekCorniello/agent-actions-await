# pr-watch-mcp — project plan

## Goal

An installable, standalone MCP server in TypeScript, run with `npx`. It lets agents wait on GitHub PR checks and workflow runs without polling in a bash loop. It works with any MCP client, over the older stateful Streamable HTTP and the newer stateless-first spec from 2026-07-28, and over stdio too.

Each user runs their own local instance. The author hosts nothing for anyone else.

## Non-goals

- No central relay service.
- No third party account needed by default.
- Not a general GitHub API wrapper. It is scoped to waiting on PR CI status.
- Not tied to one agent harness. This is a standalone MCP server, not a Claude Code plugin.

## MCP compatibility note

The 2026-07-28 spec removed protocol sessions like `Mcp-Session-Id` and moved cross-call state into handles passed as tool arguments. That does not stop a single call from taking a while. It is still one slow, self-contained response. To stay compatible with every client we expose two tool shapes over one backend rather than choosing one.

## Architecture

```
GitHub --webhook--> cloudflared quick tunnel --> local HTTP receiver
                         (ephemeral,                    |
                          no account)                   v
                                                  Event bus (in-process
                                                  EventEmitter, keyed
                                                  by owner/repo@sha)
                                                         |
                                                         v
                                           MCP server -- await_pr_actions
                                                         |
                                                    Agent tool call
                                                    (blocks, then resolves)
```

Everything runs as one local Node process per user, started by their agent harness. `cloudflared` runs as a child of that same process.

## Components

### 1. src/tunnel.ts — tunnel manager

- Finds a `cloudflared` binary for the user OS and arch, or checks `PATH` first.
- Spawns `cloudflared tunnel --url http://localhost:<port>` as a child.
- Reads stdout for the `https://<random>.trycloudflare.com` URL.
- Exposes the current public URL to the rest of the app.
- Restarts the child and reregisters the webhook if it dies or the URL changes. Quick tunnel URLs are not stable across restarts.

### 2. src/webhook.ts — receiver

- Small HTTP server, or a route on the same port as the MCP server.
- Checks `X-Hub-Signature-256` against the webhook secret on every request. This is required because quick tunnel URLs have no network auth.
- Parses `check_suite`, `check_run`, `workflow_run`, `pull_request`, and `status` payloads.
- Normalizes each into an internal event like `{ owner, repo, sha, type, status, conclusion, name }`.
- Publishes normalized events onto the bus, keyed by `owner/repo@sha`.

### 3. src/bus.ts — event bus

- Thin wrapper around Node `EventEmitter`, single process, in memory.
- Keyed by `owner/repo@sha`.
- No Redis or external store for now. A single local process is the target. We can revisit if someone splits receiver and MCP across machines.

### 4. src/github.ts — GitHub REST helpers

- Resolve a PR number to its current head SHA.
- Fetch the expected check set for a SHA at call time, so we know when everything has reported instead of returning on the first `completed` event.
- Register or update the repo webhook through `gh api` or Octokit. It tries `gh` auth first, then prints manual steps.

### 5. src/mcp-server.ts — the MCP server, two tool shapes over one backend

Both shapes use the same watch. Given `owner, repo, pr_number`, resolve the head SHA, fetch the expected checks, and subscribe to the bus for that SHA. The rest is how we show it to the caller.

Surface A — handle and poll. This is the universal default.

- `start_pr_watch(owner, repo, pr_number)` creates a watch and returns a `handle` right away. No open request.
- `get_pr_watch_status(handle)` returns current state `pending` or `completed` and, when done, the per-check results. It works the same on stdio, older Streamable HTTP, and the 2026-07-28 stateless spec. Recommend this in docs.

Surface B — blocking wrapper.

- `await_pr_actions(owner, repo, pr_number, timeout_seconds = 600)` calls `start_pr_watch` inside, then holds the response open until the watch finishes or times out. It is still one self-contained request, but it needs the path between client and server to keep the connection open. Good for harnesses that want simple agent code.
- If the harness supports MCP progress notifications, we send one per event. Otherwise we return once at the end.

Shared fallback. If no webhook arrives within a short window such as 30 seconds after GitHub would show an update, we poll the GitHub REST API once instead of hanging.

### 6. bin/cli.ts — setup and run CLI

- `npx pr-watch-mcp init`
  - Checks for `gh` CLI auth.
  - Starts the tunnel and reads the public URL.
  - Registers the repo webhook through `gh api repos/{owner}/{repo}/hooks` for `check_suite`, `check_run`, `workflow_run`, `pull_request`.
  - Creates a webhook secret locally.
  - Writes a local config file with repos, port, and secret path.
- `npx pr-watch-mcp start`
  - Starts tunnel, receiver, and MCP server together.
  - If the tunnel URL changes on restart, it patches the webhook config automatically.

## Key design decisions

- Key events by commit SHA, not PR number. A PR can get new commits while you wait. We reresolve the head SHA if it moves and reset the wait.
- All checks settled needs a baseline. We fetch the check suite list once at call time and do not return on the first `completed` event.
- Tunnel default is `cloudflared` quick tunnel. No account, no shared relay. We avoided `smee.io` because a maintainer reported it getting unstable under shared traffic. The tradeoff is an ephemeral URL, about 200 concurrent requests, and no SLA. That is fine for webhook volume.
- Signature check is required. Quick tunnel URLs allow anyone who knows the hostname to POST, so the receiver must check `X-Hub-Signature-256`.
- No Redis for now. Single local process is the target.
- Two tool shapes, one backend. Handle and poll works everywhere, so we recommend it. `await_pr_actions` is a convenience wrapper for harnesses that prefer one call and can keep the connection open.

## Milestones

1. Core loop, no tunnel — webhook receiver, event bus, MCP tool, tested locally with `gh webhook` or `curl` payloads.
2. Tunnel integration — add `cloudflared` and confirm a real webhook goes end to end.
3. CLI and init flow — automate webhook registration, secret generation, and config save.
4. Restart handling — deal with tunnel URL churn, dropped webhooks with poll fallback, and process crash recovery.
5. Package and publish — `npx pr-watch-mcp` with README that covers setup and tunnel tradeoffs.
6. Stretch — streaming mode with MCP progress notifications for `await_pr_actions`.

## Open questions when we started

- Does the target harness show MCP progress mid-call, or should we skip streaming for now?
- Does one instance need to watch many repos, or one per repo?
- Should we wait on required checks only or on every check suite?
