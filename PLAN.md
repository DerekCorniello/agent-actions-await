# pr-watch-mcp — Project Plan

## Goal

An installable, standalone MCP server (TypeScript, distributed via `npx`)
that gives agents a way to wait on GitHub PR checks/workflow runs without
polling in a bash sleep loop — usable by any MCP-compatible harness, on
either the legacy stateful Streamable HTTP spec or the newer
stateless-first spec (2026-07-28), and by plain stdio clients too.

Zero shared/hosted infrastructure: every user runs their own local instance.
Nobody, including the tool's author, hosts anything on anyone else's behalf.

## Non-goals

- No centralized relay service.
- No requirement for users to create third-party accounts by default.
- Not a general GitHub API wrapper — scoped to "wait on PR CI status."
- Not tied to one agent harness (this is a standalone MCP server, not a
  Claude-Code-specific plugin).

## MCP compatibility note

The 2026-07-28 spec removed protocol-level sessions (`Mcp-Session-Id`) in
favor of self-contained requests; cross-call state is now expected to be
passed explicitly as a handle in tool arguments, not held in transport
state. This doesn't forbid a single call from taking a long time to
respond — that's still just a slow, self-contained response — but it does
mean we shouldn't design around session identity between separate calls.
Given that, and wanting this usable by literally any client, the server
exposes **two tool surfaces over one shared backend** (see below) rather
than picking one shape.

## Architecture

```
GitHub ──webhook──▶ cloudflared quick tunnel ──▶ local HTTP receiver
                          (ephemeral,                    │
                           no account)                   ▼
                                                   Event bus (in-process
                                                   EventEmitter, keyed
                                                   by owner/repo@sha)
                                                          │
                                                          ▼
                                            MCP server ── await_pr_actions
                                                          │
                                                     Agent tool call
                                                     (blocks, then resolves)
```

Everything above runs as one local Node process per user, spawned by their
own agent harness. `cloudflared` runs as a child process of that same
process.

## Components

### 1. `src/tunnel.ts` — tunnel manager
- Downloads/locates the `cloudflared` binary for the user's OS/arch (or
  shells out if already installed; check `PATH` first).
- Spawns `cloudflared tunnel --url http://localhost:<port>` as a child
  process.
- Parses stdout for the generated `https://<random>.trycloudflare.com` URL.
- Exposes the current public URL to the rest of the app.
- Restarts the subprocess and re-registers the webhook if it dies or the
  URL changes (quick tunnel URLs are not stable across restarts).

### 2. `src/webhook.ts` — receiver
- Minimal HTTP server (or a route mounted alongside the MCP server if it
  also speaks HTTP).
- Verifies `X-Hub-Signature-256` against the webhook secret on every
  request — mandatory, since quick tunnel URLs have no auth of their own.
- Parses `check_suite`, `check_run`, `workflow_run`, and `pull_request`
  payloads.
- Normalizes each into an internal event: `{ owner, repo, sha, type, status, conclusion, name }`.
- Publishes normalized events onto the event bus, keyed by `owner/repo@sha`.

### 3. `src/bus.ts` — event bus
- Thin wrapper around Node's `EventEmitter`, single-process, in-memory.
- Keyed by `owner/repo@sha`.
- No external dependency (no Redis) for v1 — single local process is the
  target deployment shape.

### 4. `src/github.ts` — GitHub REST helpers
- Resolve a PR number to its current head SHA.
- Fetch the expected set of check suites/required checks for a SHA at
  tool-call time, so the tool knows when "everything has reported in"
  rather than resolving on the first `completed` event it sees.
- Register/update the repo webhook via `gh api` or Octokit (auto-register
  using the user's existing `gh` auth if available; otherwise print
  manual setup instructions).

### 5. `src/mcp-server.ts` — the MCP server, two tool surfaces over one backend

Both surfaces sit on top of the same watch primitive: given
`(owner, repo, pr_number)`, resolve the head SHA, fetch the expected
check set, and subscribe to the bus key for that SHA. Everything below is
just how that primitive is exposed to a caller.

**Surface A — handle + poll (the universal, forward-compatible default)**
- `start_pr_watch(owner, repo, pr_number)` → creates a watch, returns a
  `handle` immediately. No held-open request.
- `get_pr_watch_status(handle)` → returns current status
  (`pending` / `completed`) and, once completed, the per-check results.
  Cheap, stateless-per-call, safe behind any load balancer or gateway,
  works identically on stdio, legacy Streamable HTTP, and the
  2026-07-28 stateless spec. This is the one to recommend as the default
  in docs.

**Surface B — blocking convenience wrapper**
- `await_pr_actions(owner, repo, pr_number, timeout_seconds = 600)` →
  internally calls the same `start_pr_watch`, then holds the response
  open (subscribed to the bus) until the watch resolves or times out.
  Still a single self-contained request — valid under either spec
  version — but relies on the transport/infra between client and server
  tolerating a long-held connection. Offered for harnesses that prefer
  simple one-call agent code and don't need to worry about intervening
  proxies.
- If the harness supports MCP progress notifications, emit one per
  incoming event as a streaming variant of this surface; otherwise just
  resolve once at the end.

**Shared fallback safety net** (applies to both surfaces): if no webhook
event arrives within some grace window (e.g. 30s past when GitHub's own
UI would show updates), do one manual poll against the GitHub REST API
rather than hanging forever on a dropped delivery.

### 6. `bin/cli.ts` — setup/run CLI
- `npx pr-watch-mcp init`
  - Checks for `gh` CLI auth.
  - Starts the tunnel, gets the public URL.
  - Registers the repo webhook (via `gh api repos/{owner}/{repo}/hooks`)
    pointed at that URL, subscribed to `check_suite`, `check_run`,
    `workflow_run`, `pull_request`.
  - Generates and stores a webhook secret locally.
  - Writes a local config file (repo(s) to watch, port, secret path).
- `npx pr-watch-mcp start`
  - Starts tunnel + receiver + MCP server together.
  - On tunnel URL change (restart), re-PATCHes the webhook config
    automatically.

## Key design decisions

- **Key events by commit SHA, not PR number.** A PR can get new commits
  mid-wait. Decide: does "await" mean "this exact commit" or "PR's current
  head"? Default to re-resolving head SHA if it moves during a wait, and
  treat that as a reset of the wait.
- **"All checks settled" needs an expected-count baseline.** Fetch the
  check-suite list once at call time; don't resolve on the first
  `completed` event blindly.
- **Tunnel default: `cloudflared` quick tunnel.** No account, no shared
  third-party relay (ruled out `smee.io` — a maintainer has reported it
  becoming unstable under exactly this kind of shared-traffic load
  before). Tradeoff: ephemeral URL, ~200 concurrent request cap, no SLA —
  acceptable for this use case's traffic volume.
- **Signature verification is not optional.** Quick tunnel URLs are
  unauthenticated at the network level — anyone who learns the hostname
  could POST to it — so the receiver must always verify
  `X-Hub-Signature-256`.
- **No Redis/external state for v1.** Single local process is the
  target shape; revisit only if someone wants a receiver and MCP server
  split across machines.
- **Two tool surfaces, one backend.** Handle + poll (`start_pr_watch` /
  `get_pr_watch_status`) is the universal default that works regardless
  of MCP spec version or what's sitting between client and server;
  `await_pr_actions` is a blocking convenience wrapper around the same
  mechanism, offered but not the primary recommendation, since long-held
  connections are the one thing that can be fragile behind certain
  infra.

## Milestones

1. **Core loop, no tunnel** — webhook receiver + event bus + MCP tool,
   tested locally with `gh webhook` simulate or manual `curl` payloads.
2. **Tunnel integration** — wire in `cloudflared`, confirm a real GitHub
   webhook round-trips end to end.
3. **CLI/init flow** — automate webhook registration, secret generation,
   config persistence.
4. **Restart resilience** — handle tunnel URL churn, dropped webhook
   deliveries (poll fallback), process crash recovery.
5. **Package + publish** — `npx pr-watch-mcp`, README with setup steps and
   the Cloudflare-tunnel-vs-named-tunnel tradeoff documented.
6. **(Stretch) streaming mode** — MCP progress notifications for
   intermediate check status instead of one final return, layered onto
   the `await_pr_actions` surface.

## Open questions

- Does the target agent harness support MCP progress notifications
  mid-call, or should streaming mode be dropped for v1?
- Multi-repo: does one running instance need to watch several repos at
  once, or is it one instance per repo?
- Required vs all checks: should timeout/resolution logic only care about
  branch-protection "required" checks, or every check suite regardless?
