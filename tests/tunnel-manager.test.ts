import { describe, it, expect, vi } from "vitest";
import { TunnelManager, repatchWebhookWithRetry } from "../src/tunnel-manager.js";

describe("TunnelManager", () => {
    it("instantiates and getUrl is null before start", () => {
        const mgr = new TunnelManager({ port: 3000, binPath: "/tmp/cloudflared", backoffMs: 10 });
        expect(mgr.getUrl()).toBeNull();
        mgr.stop();
    });

    it("start calls ensureBin/start, emits url and repatches hooks", async () => {
        const fakeProc = {
            once: vi.fn(),
            on: vi.fn(),
            kill: vi.fn(),
        } as unknown as import("node:child_process").ChildProcess;
        const fakeTunnel = {
            url: "https://xyz.trycloudflare.com",
            proc: fakeProc,
            stop: vi.fn(),
        } as unknown as import("../src/tunnel.js").Tunnel;
        const ensureBin = vi.fn(async () => "/tmp/cloudflared");
        const start = vi.fn(async () => fakeTunnel);
        const repatch = vi.fn(async () => {});
        const onUrl = vi.fn();
        const mgr = new TunnelManager({
            port: 4000,
            ensureBin,
            start: start as unknown as typeof import("../src/tunnel.js").startTunnel,
            repatch,
            hooks: [{ owner: "acme", repo: "demo", hookId: 42 }],
            onUrl,
            backoffMs: 10,
        });
        const url = await mgr.start();
        expect(url).toBe("https://xyz.trycloudflare.com");
        expect(ensureBin).toHaveBeenCalled();
        expect(start).toHaveBeenCalledWith(4000, "/tmp/cloudflared");
        expect(onUrl).toHaveBeenCalledWith("https://xyz.trycloudflare.com");
        expect(repatch).toHaveBeenCalledWith("acme", "demo", 42, "https://xyz.trycloudflare.com");
        expect(mgr.getUrl()).toBe("https://xyz.trycloudflare.com");
        mgr.stop();
    });

    it("uses binPath directly when provided, skipping ensureBin", async () => {
        const fakeProc = {
            once: vi.fn(),
            on: vi.fn(),
            kill: vi.fn(),
        } as unknown as import("node:child_process").ChildProcess;
        const fakeTunnel = {
            url: "https://abc.trycloudflare.com",
            proc: fakeProc,
            stop: vi.fn(),
        } as unknown as import("../src/tunnel.js").Tunnel;
        const ensureBin = vi.fn(async () => "/should/not/be/called");
        const start = vi.fn(async () => fakeTunnel);
        const mgr = new TunnelManager({
            port: 4000,
            binPath: "/tmp/from-arg",
            ensureBin,
            start: start as unknown as typeof import("../src/tunnel.js").startTunnel,
            backoffMs: 10,
        });
        await mgr.start();
        expect(ensureBin).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledWith(4000, "/tmp/from-arg");
        mgr.stop();
    });

    it("repatchWebhookWithRetry patches on first try", async () => {
        const patch = vi.fn(async () => {});
        const create = vi.fn(async () => 123);
        await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", {
            patch,
            create,
        });
        expect(patch).toHaveBeenCalledWith("acme", "demo", 1, "https://new.trycloudflare.com");
        expect(create).not.toHaveBeenCalled();
    });

    it("repatch falls back to create on 404", async () => {
        const patch = vi.fn(async () => {
            throw new Error("404 not found");
        });
        const create = vi.fn(async () => 99);
        await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", {
            patch,
            create,
        });
        expect(create).toHaveBeenCalledWith("acme", "demo", "https://new.trycloudflare.com");
    });

    it("repatch retries on transient and then succeeds", async () => {
        let calls = 0;
        const patch = vi.fn(async () => {
            calls++;
            if (calls < 3) throw new Error("500 transient");
            return;
        });
        const create = vi.fn(async () => 1);
        await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", {
            patch,
            create,
        });
        expect(calls).toBe(3);
    });

    it("repatch throws on 401 without retry", async () => {
        const patch = vi.fn(async () => {
            throw new Error("401 unauthorized");
        });
        const create = vi.fn(async () => 1);
        await expect(
            repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", {
                patch,
                create,
            }),
        ).rejects.toThrow(/401/);
        expect(create).not.toHaveBeenCalled();
    });
});
