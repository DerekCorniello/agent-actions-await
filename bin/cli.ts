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
    process.stdout.write(usageText());
    process.exit(0);
}

async function ensureRepoConfig(owner: string, repo: string, port: number): Promise<void> {
    const cfg = await loadConfig();
    if (cfg.repos.some((r) => r.owner === owner && r.repo === repo)) return;
    const secretPath = await ensureSecret(owner, repo);
    const secret = await readSecret(owner, repo);
    if (!secret) throw new Error(`failed to create webhook secret for ${owner}/${repo}`);
    try {
        execSync("gh auth status", { stdio: "ignore" });
        const payload = buildHookPayload("https://placeholder.trycloudflare.com/webhook", secret);
        const out = execSync(`gh api repos/${owner}/${repo}/hooks --input -`, {
            input: payload,
            encoding: "utf8",
        }) as string;
        const hook = JSON.parse(out) as { id: number };
        cfg.repos.push({ owner, repo, hookId: hook.id, secretPath });
    } catch (error) {
        process.stderr.write(
            `Could not configure a webhook for ${owner}/${repo}; polling fallback will be used: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        cfg.repos.push({ owner, repo, secretPath });
    }
    cfg.port = port;
    await saveConfig(cfg);
}

async function cmdDoctor(): Promise<void> {
    const cfg = await loadConfig();
    const tokenAvailable = Boolean(
        process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_PAT,
    );
    let ghAvailable = false;
    if (!tokenAvailable) {
        try {
            execSync("gh auth status", { stdio: "ignore" });
            ghAvailable = true;
        } catch {
            ghAvailable = false;
        }
    }
    const configuredHooks = cfg.repos.filter((r) => r.hookId !== undefined).length;
    const webhookMode =
        configuredHooks === 0
            ? "polling only (no configured webhook hooks)"
            : `webhooks configured for ${configuredHooks} of ${cfg.repos.length} repositories`;
    process.stdout.write(
        `GitHub auth: ${tokenAvailable ? "environment token available" : ghAvailable ? "gh CLI authenticated" : "unavailable"}\n`,
    );
    process.stdout.write(`Webhook mode: ${webhookMode}\n`);
}

async function bootstrapTunnel(
    port: number,
    url: string,
    shutdownRequested: () => boolean,
    registerTunnel: (mgr: TunnelManager) => void,
): Promise<void> {
    if (shutdownRequested()) return;
    let cfg = await loadConfig();
    if (!cfg.repos.length) {
        const repo = getGitRemoteOwnerRepo();
        if (repo) {
            if (shutdownRequested()) return;
            await ensureRepoConfig(repo.owner, repo.repo, cfg.port ?? 0);
            if (shutdownRequested()) return;
            cfg = await loadConfig();
        } else {
            process.stderr.write("No repository detected; polling fallback is active.\n");
        }
    }
    const hooks = cfg.repos
        .filter((r) => r.hookId !== undefined)
        .map((r) => ({ owner: r.owner, repo: r.repo, hookId: r.hookId! }));
    if (!hooks.length) {
        process.stderr.write("No webhook hooks configured; polling fallback is active.\n");
        return;
    }
    if (shutdownRequested()) return;
    const bin = await ensureCloudflared();
    if (shutdownRequested()) return;
    const mgr = new TunnelManager({
        port,
        binPath: bin,
        hooks,
        onUrl: (newUrl) => process.stderr.write(`Tunnel ${newUrl} -> ${url}\n`),
        onError: (err) => process.stderr.write(`Tunnel: ${err.message}\n`),
        repatch: async (owner, repo, hookId, newUrl) => {
            const updatedId = await repatchWebhookWithRetry(
                owner,
                repo,
                hookId,
                `${newUrl}/webhook`,
                {
                    patch: async (o, r, id, hookUrl) => {
                        const secret = await readSecret(o, r);
                        if (!secret) throw new Error(`missing webhook secret for ${o}/${r}`);
                        const payload = buildHookPayload(hookUrl, secret);
                        execSync(`gh api --method PATCH repos/${o}/${r}/hooks/${id} --input -`, {
                            input: payload,
                            stdio: ["pipe", "ignore", "pipe"],
                        });
                    },
                    create: async (o, r, hookUrl) => {
                        const secret = await readSecret(o, r);
                        if (!secret) throw new Error(`missing webhook secret for ${o}/${r}`);
                        const payload = buildHookPayload(hookUrl, secret);
                        const out = execSync(`gh api repos/${o}/${r}/hooks --input -`, {
                            input: payload,
                            encoding: "utf8",
                        }) as string;
                        return (JSON.parse(out) as { id: number }).id;
                    },
                    onError: (err) => process.stderr.write(`${err.message}\n`),
                },
            );
            if (updatedId !== hookId) {
                const current = await loadConfig();
                const repoConfig = current.repos.find((r) => r.owner === owner && r.repo === repo);
                if (repoConfig) {
                    repoConfig.hookId = updatedId;
                    await saveConfig(current);
                }
            }
            return updatedId;
        },
    });
    registerTunnel(mgr);
    try {
        await mgr.start();
        if (shutdownRequested()) mgr.stop();
    } catch (error) {
        mgr.stop();
        process.stderr.write(
            `Tunnel setup failed; polling fallback remains active: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
}

async function cmdStart(pollingOnly: boolean): Promise<void> {
    const cfg = await loadConfig();
    const bus = new EventBus();
    const wm = new WatchManager(bus);
    const {
        server: httpServer,
        port,
        url,
    } = await createHttpServer({
        bus,
        getSecret: makeSecretGetter(),
        port: cfg.port ?? 0,
        host: "127.0.0.1",
    });
    const poller = new FallbackPoller(wm, {
        intervalMs: (cfg.pollIntervalSeconds ?? 15) * 1000,
        graceMs: (cfg.pollGraceSeconds ?? 30) * 1000,
    });
    poller.start();

    const mcp = createMcpServer({ bus, watchManager: wm });
    const transport = new StdioServerTransport();
    try {
        await mcp.connect(transport);
    } catch (error) {
        poller.stop();
        httpServer.close();
        throw new Error(
            `Could not connect MCP stdio transport: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    process.stderr.write(`MCP stdio connected; webhook receiver listening at ${url}\n`);
    let stopped = false;
    let activeTunnel: TunnelManager | undefined;
    const shutdownRequested = () => stopped;
    const registerTunnel = (mgr: TunnelManager) => {
        activeTunnel = mgr;
        if (stopped) mgr.stop();
    };
    await new Promise<void>((resolve) => {
        let shutdownStarted = false;
        const shutdown = () => {
            if (shutdownStarted) return;
            shutdownStarted = true;
            stopped = true;
            poller.stop();
            activeTunnel?.stop();
            httpServer.close();
            void mcp.close().finally(resolve);
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        mcp.onclose = shutdown;
        process.stdin.once("end", shutdown);
        if (process.stdin.readableEnded) shutdown();
        if (!pollingOnly)
            void bootstrapTunnel(port, url, shutdownRequested, registerTunnel).catch(
                (error: unknown) => {
                    process.stderr.write(
                        `Webhook setup failed; polling fallback remains active: ${error instanceof Error ? error.message : String(error)}\n`,
                    );
                },
            );
    });
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) usage();
    if (args.includes("doctor")) return cmdDoctor();
    const unknown = args.filter((arg) => arg !== "--polling-only");
    if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
    await cmdStart(args.includes("--polling-only"));
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
