#!/usr/bin/env node
// Postinstall hook for agent-actions-await.
// PR1 stub: actual cloudflared pin+checksum download lands in PR5.
// For now, no-op so `npm install` succeeds in scaffold.
import process from "node:process";

if (process.env.AGENT_ACTIONS_AWAIT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}
// No-op placeholder — tunnel manager will lazy-download on first `start` if needed.
process.exit(0);
