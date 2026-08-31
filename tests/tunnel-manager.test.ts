import { describe, it, expect, vi } from "vitest";
import { TunnelManager, repatchWebhookWithRetry } from "../src/tunnel-manager.js";

describe("TunnelManager", () => {
  it("instantiates and getUrl is null before start", () => {
    const mgr = new TunnelManager({ port: 3000, binPath: "/tmp/cloudflared", backoffMs: 10 });
    expect(mgr.getUrl()).toBeNull();
    mgr.stop();
  });

  it("repatchWebhookWithRetry patches on first try", async () => {
    const patch = vi.fn(async () => {});
    const create = vi.fn(async () => 123);
    await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", { patch, create });
    expect(patch).toHaveBeenCalledWith("acme", "demo", 1, "https://new.trycloudflare.com");
    expect(create).not.toHaveBeenCalled();
  });

  it("repatch falls back to create on 404", async () => {
    const patch = vi.fn(async () => {
      throw new Error("404 not found");
    });
    const create = vi.fn(async () => 99);
    await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", { patch, create });
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
    await repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", { patch, create });
    expect(calls).toBe(3);
  });

  it("repatch throws on 401 without retry", async () => {
    const patch = vi.fn(async () => {
      throw new Error("401 unauthorized");
    });
    const create = vi.fn(async () => 1);
    await expect(repatchWebhookWithRetry("acme", "demo", 1, "https://new.trycloudflare.com", { patch, create })).rejects.toThrow(/401/);
    expect(create).not.toHaveBeenCalled();
  });
});
