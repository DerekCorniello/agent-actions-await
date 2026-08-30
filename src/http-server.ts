import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { EventBus } from "./bus.js";
import { handleWebhookRequest, DeliveryDedup } from "./webhook.js";
import type { WatchManager } from "./watch-manager.js";

export type HttpServerOpts = {
  bus: EventBus;
  watchManager?: WatchManager; // for future MCP HTTP
  getSecret: (owner: string, repo: string) => string | undefined;
  port?: number; // 0 = random free per Q31
  host?: string; // 127.0.0.1 per Q23
  dedup?: DeliveryDedup;
  maxBytes?: number;
};

/**
 * Single-port server with two routes per Q7: POST /webhook + GET /health
 * MCP stdio is separate; MCP HTTP (if needed) can be added as POST /mcp later.
 * Tunnel forwards to this port; MCP is intended localhost-only (Q23) — we don't
 * expose /mcp via tunnel in this version, but same server can serve it locally.
 */
export async function createHttpServer(opts: HttpServerOpts): Promise<{ server: Server; port: number; url: string }> {
  const dedup = opts.dedup ?? new DeliveryDedup();
  const maxBytes = opts.maxBytes;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (maxBytes !== undefined && size > maxBytes) {
          // still drain but will 413
        }
        chunks.push(c);
      });
      await new Promise<void>((resolve) => req.on("end", () => resolve()));
      const raw = Buffer.concat(chunks);
      // Normalize headers to record
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
      const result = await handleWebhookRequest(
        { method: req.method!, headers, url: req.url! },
        raw,
        { bus: opts.bus, getSecret: opts.getSecret, dedup, ...(maxBytes !== undefined ? { maxBytes } : {}) },
      );
      res.writeHead(result.status, { "content-type": "text/plain" });
      res.end(result.body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as { port: number };
  const url = `http://${host}:${addr.port}`;
  return { server, port: addr.port, url };
}
