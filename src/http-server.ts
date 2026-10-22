import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventBus } from "./bus.js";
import { handleWebhookRequest, DeliveryDedup } from "./webhook.js";

export const MAX_WEBHOOK_PAYLOAD_BYTES = 1_000_000;

export type HttpServerOpts = {
    bus: EventBus;
    getSecret: (owner: string, repo: string) => string | undefined;
    port?: number; // 0 = random free per Q31
    host?: string; // 127.0.0.1 per Q23
    dedup?: DeliveryDedup;
    maxBytes?: number;
};

/**
 * Single-port server with two routes per Q7: POST /webhook + GET /health
 * MCP uses stdio. This HTTP server only accepts webhooks and health checks.
 */
export async function createHttpServer(
    opts: HttpServerOpts,
): Promise<{ server: Server; port: number; url: string }> {
    const dedup = opts.dedup ?? new DeliveryDedup();
    const maxBytes = opts.maxBytes ?? MAX_WEBHOOK_PAYLOAD_BYTES;
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname === "/health" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url.pathname === "/webhook" && req.method === "POST") {
            const headers: Record<string, string | string[] | undefined> = {};
            for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
            const contentLength = Number(req.headers["content-length"]);
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                req.resume();
                res.writeHead(413, { "content-type": "text/plain" });
                res.end("payload too large");
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let tooLarge = false;
            req.on("data", (c: Buffer) => {
                size += c.length;
                if (maxBytes !== undefined && size > maxBytes) {
                    tooLarge = true;
                    chunks.length = 0;
                } else if (!tooLarge) {
                    chunks.push(c);
                }
            });
            const complete = await new Promise<boolean>((resolve) => {
                req.once("end", () => resolve(true));
                req.once("aborted", () => resolve(false));
                req.once("error", () => resolve(false));
            });
            if (!complete) {
                if (!res.headersSent && !res.destroyed) {
                    res.writeHead(400, { "content-type": "text/plain" });
                    res.end("incomplete request");
                }
                return;
            }
            if (tooLarge) {
                res.writeHead(413, { "content-type": "text/plain" });
                res.end("payload too large");
                return;
            }
            const raw = Buffer.concat(chunks);
            const result = await handleWebhookRequest(
                { method: req.method!, headers, url: req.url! },
                raw,
                {
                    bus: opts.bus,
                    getSecret: opts.getSecret,
                    dedup,
                    maxBytes,
                },
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
