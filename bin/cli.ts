#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createHttpServer } from "../src/http-server.js";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import { FallbackPoller } from "../src/poller.js";
import { createMcpServer } from "../src/mcp-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    loadConfig,
    saveConfig,
    ensureSecret,
    readSecret,
    makeSecretGetter,
} from "../src/config.js";
import { ensureCloudflared } from "../src/tunnel.js";
import { TunnelManager, repatchWebhookWithRetry } from "../src/tunnel-manager.js";
import { buildHookPayload, usageText } from "../src/cli-helpers.js";
import { getGitRemoteOwnerRepo } from "../src/git.js";

function usage(): never {
    console.log(usageText());
    process.exit(0);
}

async function ensureRepoConfig(owner: string, repo: string, port: number): Promise<void> {
    const cfg = await loadConfig();
    if (cfg.repos?.some((r) => r.owner === owner && r.repo === repo)) return;
    if (!cfg.repos) cfg.repos = [];
    const secretPath = await ensureSecret(owner, repo);
    const secret = await readSecret(owner, repo);
    if (!secret) throw new Error("failed to create secret");
    try {
        execSync("gh auth status", { stdio: "ignore" });
        const hookUrl = `https://placeholder.trycloudflare.com/webhook`;
        const payload = buildHookPayload(hookUrl, secret);
        const out = execSync(`gh api repos/${owner}/${repo}/hooks --input -`, {
            input: payload,
            encoding: "utf8",
        }) as string;
        const j = JSON.parse(out) as { id: number };
        cfg.repos.push({ owner, repo, hookId: j.id, secretPath });
    } catch {
        cfg.repos.push({ owner, repo, secretPath });
    }
    cfg.port = port;
    await saveConfig(cfg);
}

async function cmdStart(): Promise<void> {
    let cfg = await loadConfig();
    if (!cfg.repos || cfg.repos.length === 0) {
        const g = getGitRemoteOwnerRepo();
        if (g) {
            await ensureRepoConfig(g.owner, g.repo, cfg.port ?? 0);
            cfg = await loadConfig();
        } else {
            console.log("no repos configured — polling fallback active");
        }
    }
    const bus = new EventBus();
    const wm = new WatchManager(bus);
    const getSecret = makeSecretGetter();

    const { port: actualPort, url } = await createHttpServer({
        bus,
        getSecret,
        port: cfg.port ?? 0,
        host: "127.0.0.1",
    });
    console.log(`webhook receiver listening ${url} (health ${url}/health)`);

    const poller = new FallbackPoller(wm, {
        intervalMs: (cfg.pollIntervalSeconds ?? 15) * 1000,
        graceMs: (cfg.pollGraceSeconds ?? 30) * 1000,
    });
    poller.start();

    try {
        const bin = await ensureCloudflared();
        const hooks = cfg.repos
            .filter((r) => r.hookId !== undefined)
            .map((r) => ({ owner: r.owner, repo: r.repo, hookId: r.hookId! }));
        const mgr = new TunnelManager({
            port: actualPort,
            binPath: bin,
            hooks,
            onUrl: (newUrl) => console.log(`tunnel ${newUrl} -> ${url}`),
            onError: (err) => console.warn("tunnel:", err.message),
            repatch: async (owner, repo, hookId, newUrl) => {
                await repatchWebhookWithRetry(owner, repo, hookId, `${newUrl}/webhook`, {
                    patch: async (o, r, id, u) => {
                        execSync(
                            `gh api --method PATCH repos/${o}/${r}/hooks/${id} -f config[url]=${u}`,
                            {
                                stdio: "ignore",
                            },
                        );
                    },
                    create: async (o, r, u) => {
                        const payload = buildHookPayload(u, (await readSecret(o, r)) ?? "");
                        const out = execSync(`gh api repos/${o}/${r}/hooks --input -`, {
                            input: payload,
                            encoding: "utf8",
                        }) as string;
                        const j = JSON.parse(out) as { id: number };
                        return j.id;
                    },
                    onError: (e) => console.warn(e.message),
                });
            },
        });
        await mgr.start();
        process.on("exit", () => mgr.stop());
    } catch (e: unknown) {
        console.warn(
            "tunnel failed to start (webhook will rely on poll fallback):",
            (e as Error).message,
        );
    }

    const mcp = createMcpServer({ bus, watchManager: wm });
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.log("MCP stdio server connected");
    await new Promise(() => {});
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) usage();
    await cmdStart();
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
