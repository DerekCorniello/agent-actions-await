import { startTunnel, ensureCloudflared } from "./tunnel.js";
import type { Tunnel } from "./tunnel.js";

export type RepatchFn = (owner: string, repo: string, hookId: number, newUrl: string) => Promise<void>;

export type TunnelManagerOpts = {
  port: number;
  binPath?: string;
  onUrl?: (url: string) => void;
  onError?: (err: Error) => void;
  repatch?: RepatchFn;
  hooks?: Array<{ owner: string; repo: string; hookId: number }>;
  backoffMs?: number;
};

export class TunnelManager {
  private tunnel: Tunnel | null = null;
  private stopped = false;
  private restarting = false;
  private binPath: string | null = null;

  constructor(private readonly opts: TunnelManagerOpts) {}

  async start(): Promise<string> {
    this.stopped = false;
    return this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.tunnel?.stop();
    this.tunnel = null;
  }

  getUrl(): string | null {
    return this.tunnel?.url ?? null;
  }

  private async launch(): Promise<string> {
    const bin = this.opts.binPath ?? (await ensureCloudflared().catch(() => "cloudflared"));
    this.binPath = bin;
    this.tunnel = await startTunnel(this.opts.port, bin);
    const url = this.tunnel.url;
    this.opts.onUrl?.(url);
    await this.repatchAll(url);
    this.tunnel.proc.once("exit", () => {
      if (this.stopped || this.restarting) return;
      this.handleExit();
    });
    this.tunnel.proc.once("error", (err) => {
      if (this.stopped) return;
      this.opts.onError?.(err as Error);
      this.handleExit();
    });
    return url;
  }

  private async handleExit(): Promise<void> {
    if (this.restarting || this.stopped) return;
    this.restarting = true;
    const ms = this.opts.backoffMs ?? 2000;
    await new Promise((r) => setTimeout(r, ms));
    this.restarting = false;
    if (this.stopped) return;
    try {
      await this.launch();
    } catch (e) {
      this.opts.onError?.(e as Error);
      // retry again
      void this.handleExit();
    }
  }

  private async repatchAll(newUrl: string): Promise<void> {
    if (!this.opts.repatch || !this.opts.hooks) return;
    for (const h of this.opts.hooks) {
      try {
        await this.opts.repatch(h.owner, h.repo, h.hookId, newUrl);
      } catch (e) {
        // Q16: retry PATCH with backoff, fallback to recreate, 401 prompt
        // For now, surface error and continue; caller can implement fallback
        this.opts.onError?.(e as Error);
      }
    }
  }
}

export async function repatchWebhookWithRetry(
  owner: string,
  repo: string,
  hookId: number,
  newUrl: string,
  deps: {
    patch: (owner: string, repo: string, hookId: number, url: string) => Promise<void>;
    create: (owner: string, repo: string, url: string) => Promise<number>;
    onError?: (err: Error) => void;
  },
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await deps.patch(owner, repo, hookId, newUrl);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
        deps.onError?.(new Error(`re-auth needed for ${owner}/${repo}: ${msg}`));
        throw e;
      }
      if (msg.includes("404")) {
        // hook deleted — recreate
        const newId = await deps.create(owner, repo, newUrl);
        deps.onError?.(new Error(`recreated hook ${newId} for ${owner}/${repo} after 404`));
        return;
      }
      if (attempt === maxRetries - 1) throw e;
      const backoff = Math.pow(2, attempt) * 500 + Math.random() * 200;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
