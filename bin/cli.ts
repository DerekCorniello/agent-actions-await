#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createHttpServer } from "../src/http-server.js";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { FallbackPoller } from "../src/poller.js";
import { createMcpServer } from "../src/mcp-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, saveConfig, ensureSecret, readSecret, makeSecretGetter, configPath, type AppConfig } from "../src/config.js";
import { ensureCloudflared, startTunnel, cloudflaredBinaryPath } from "../src/tunnel.js";

function usage(): never {
  console.log(`agent-actions-await — wait on GitHub PR checks without polling in bash

Usage:
  npx agent-actions-await init <owner/repo> [--port N]
  npx agent-actions-await start [--stdio] [--port N]

Commands:
  init  Register webhook for repo (via gh CLI if available), generate per-repo secret
  start Start tunnel + webhook receiver + MCP server (stdio default, HTTP on port)

Options:
  --help  Show this help
`);
  process.exit(0);
}

function parseOwnerRepo(arg: string): { owner: string; repo: string } {
  const [owner, repo] = arg.split("/");
  if (!owner || !repo) {
    console.error("expected <owner/repo> e.g. acme/demo");
    process.exit(1);
  }
  return { owner, repo };
}

async function cmdInit(ownerRepo: string, portArg?: string): Promise<void> {
  const { owner, repo } = parseOwnerRepo(ownerRepo);
  const cfg = await loadConfig();
  const port = portArg ? Number(portArg) : cfg.port ?? 0;
  if (!cfg.repos) cfg.repos = [];
  // ensure secret per Q34
  const secretPath = await ensureSecret(owner, repo);
  const secret = await readSecret(owner, repo);
  if (!secret) throw new Error("failed to create secret");
  // check gh CLI auth
  let hasGh = false;
  try {
    execSync("gh auth status", { stdio: "ignore" });
    hasGh = true;
  } catch {}
  // Try to register webhook if gh available; otherwise print manual instructions (Q22 degraded mode)
  if (hasGh) {
    try {
      // Start temporary tunnel to get URL for registration? For init we need tunnel URL.
      // We start a short-lived tunnel just to obtain public URL, then register hook.
      // If cloudflared not yet cached, postinstall or lazy will ensure.
      let bin: string;
      try {
        bin = await ensureCloudflared();
      } catch (e) {
        console.warn("cloudflared not available:", (e as Error).message);
        bin = "cloudflared";
      }
      // We need a temporary http server to satisfy tunnel --url; use ephemeral port
      const bus = new EventBus();
      const { server, port: tempPort } = await createHttpServer({ bus, getSecret: makeSecretGetter(), port });
      let url = `http://localhost:${tempPort}`;
      let tunnelUrl: string | null = null;
      try {
        const t = await startTunnel(tempPort, bin);
        tunnelUrl = t.url;
        url = tunnelUrl;
        t.stop();
      } catch {
        // fallback to manual
      }
      server.close();
      const hookUrl = `${url}/webhook`;
      // Try gh api to create hook
      const payload = JSON.stringify({
        config: { url: hookUrl, content_type: "json", secret, insecure_ssl: "0" },
        events: ["check_suite", "check_run", "workflow_run", "pull_request", "status"],
        active: true,
      });
      try {
        const out = execSync(`gh api repos/${owner}/${repo}/hooks --input -`, { input: payload, encoding: "utf8" });
        const j = JSON.parse(out) as { id: number };
        cfg.repos = cfg.repos.filter((r) => !(r.owner === owner && r.repo === repo));
        cfg.repos.push({ owner, repo, hookId: j.id, secretPath });
        cfg.port = port;
        await saveConfig(cfg);
        console.log(`webhook registered hook ${j.id} -> ${hookUrl}`);
        console.log(`config written to ${configPath()}`);
        return;
      } catch (e) {
        console.warn("gh api hook create failed, saving config for manual setup:", (e as Error).message);
        console.log(`Manual: create webhook at https://github.com/${owner}/${repo}/settings/hooks/new`);
        console.log(`Payload URL: ${hookUrl}`);
        console.log(`Secret: ${secret.slice(0, 8)}... (${secretPath})`);
        console.log(`Events: check_suite, check_run, workflow_run, pull_request, status`);
      }
    } catch (e) {
      console.warn("init tunnel/webhook error:", (e as Error).message);
    }
  } else {
    console.log("gh CLI not authenticated — manual webhook setup required (Q22 degraded mode, polling fallback active)");
    console.log(`1) Go to https://github.com/${owner}/${repo}/settings/hooks/new`);
    console.log(`2) Payload URL: <your tunnel URL>/webhook (run 'npx agent-actions-await start' to see URL)`);
    console.log(`3) Secret: stored at ${secretPath}`);
    console.log(`4) Events: check_suite, check_run, workflow_run, pull_request, status`);
    console.log(`5) Polling fallback will work until webhook is configured`);
  }
  // Save config even without hook
  cfg.repos = cfg.repos.filter((r) => !(r.owner === owner && r.repo === repo));
  cfg.repos.push({ owner, repo, secretPath });
  cfg.port = port;
  await saveConfig(cfg);
  console.log(`config written to ${configPath()} (hookId pending)`);
}

async function cmdStart(opts: { stdio: boolean; port?: number }): Promise<void> {
  const cfg = await loadConfig();
  const bus = new EventBus();
  const wm = new WatchManager(bus);
  const getSecret = makeSecretGetter();

  const port = opts.port ?? cfg.port ?? 0;
  const { server, port: actualPort, url } = await createHttpServer({ bus, getSecret, port, host: "127.0.0.1" });
  console.log(`webhook receiver listening ${url} (health ${url}/health)`);

  // Fallback poller with GHE-aware auth per repo (uses env tokens)
  const poller = new FallbackPoller(wm, {
    intervalMs: (cfg.pollIntervalSeconds ?? 15) * 1000,
    graceMs: (cfg.pollGraceSeconds ?? 30) * 1000,
  });
  poller.start();

  // Tunnel (lazy download if needed)
  let tunnelUrl: string | null = null;
  try {
    const bin = await ensureCloudflared();
    const t = await startTunnel(actualPort, bin);
    tunnelUrl = t.url;
    console.log(`tunnel ${tunnelUrl} -> ${url}`);
    // Re-PATCH hooks to new URL on restart — handled via tunnel restart watcher in full impl
    // For this version, log hook URLs that need PATCHing
    for (const r of cfg.repos) {
      if (r.hookId) {
        try {
          // try patch via gh if available
          try {
            execSync("gh auth status", { stdio: "ignore" });
            execSync(`gh api --method PATCH repos/${r.owner}/${r.repo}/hooks/${r.hookId} -f config[url]=${tunnelUrl}/webhook`, { stdio: "ignore" });
            console.log(`patched hook ${r.hookId} for ${r.owner}/${r.repo} -> ${tunnelUrl}/webhook`);
          } catch {}
        } catch {}
      }
    }
    process.on("exit", () => t.stop());
  } catch (e) {
    console.warn("tunnel failed to start (webhook will rely on poll fallback):", (e as Error).message);
  }

  if (opts.stdio) {
    const mcp = createMcpServer({ bus, watchManager: wm });
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.log("MCP stdio server connected");
  } else {
    // For Streamable HTTP, we share same port's /mcp? Not yet — log hint
    console.log("MCP stdio ready; for HTTP use --stdio or configure harness to spawn stdio");
    console.log(`Pending watches: ${wm.handleCount()}`);
  }

  // Keep alive
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage();
  const cmd = args[0];
  if (cmd === "init") {
    const repo = args[1];
    if (!repo) {
      console.error("init requires <owner/repo>");
      process.exit(1);
    }
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? args[portIdx + 1] : undefined;
    await cmdInit(repo, port);
    return;
  }
  if (cmd === "start") {
    const stdio = !args.includes("--http-only");
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
    await cmdStart({ stdio, ...(port !== undefined ? { port } : {}) });
    return;
  }
  console.error(`unknown command: ${cmd}`);
  usage();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
