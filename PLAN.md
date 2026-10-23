# Project status

## Purpose

`agent-actions-await` is a local MCP server that waits for GitHub pull request checks, new review feedback, or either event. It is intended to keep an agent's current session open while the server waits. It cannot wake a conversation after the client has ended it.

## Current behavior

- `await_pr_actions` starts a watch and waits for a bounded window. If it returns `pending`, pass its handle to `wait_pr_watch` to continue.
- `start_pr_watch`, `wait_pr_watch`, `get_pr_watch_status`, and `cancel_pr_watch` support explicit watch lifecycle management.
- Check watches follow changes to the PR head. They can wait for every check or exact check names.
- Feedback watches collect new or edited PR conversation comments, inline review comments, and submitted reviews. Optional author filters and a quiet period control which feedback is returned and when.
- `both` mode completes as soon as checks settle or matching feedback arrives. A result can show the other condition still pending.
- The server uses MCP over stdio. Polling is always available; repository webhooks and a Cloudflare quick tunnel are optional.
- Watch handles and results live in memory. Restarting the server loses active handles.
- `npm run fake:github` starts a local simulator for PR #42 in `acme/demo`. It does not contact GitHub.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch. It uses Node 20, 22, and 24, and runs `npm ci`, build, tests, lint, and format checks. The workflow does not publish packages or deploy services.

## Current limits

- MCP uses stdio only. The separate local HTTP server receives signed GitHub webhooks; it is not an HTTP MCP endpoint.
- An exact check filter can wait until the deadline if a requested check never appears. The server cannot predict workflows that GitHub has not created yet.
- `completed` means the watch ended, not that checks passed or the PR is ready to merge. Agents must inspect the result and evaluate feedback against the user's request.

## Release

The `Publish to npm` workflow validates the release and publishes when a `v*` tag matches the package version. The first version must be published by an npm-authenticated maintainer. Configure GitHub Actions as a trusted publisher on npm after that first publish.
