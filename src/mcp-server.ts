import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EventBus } from "./bus.js";
import { WatchManager } from "./watch-manager.js";
import type { CheckFilter } from "./github.js";

const StartWatchInput = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pr_number: z.number().int().positive(),
    filter: z
        .union([z.literal("all"), z.string().min(1), z.array(z.string().min(1)).min(1)])
        .optional(),
    timeout_seconds: z.number().int().min(1).max(3600).optional(),
});

const GetStatusInput = z.object({
    handle: z.string().min(1),
});

const AwaitInput = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pr_number: z.number().int().positive(),
    filter: z
        .union([z.literal("all"), z.string().min(1), z.array(z.string().min(1)).min(1)])
        .optional(),
    timeout_seconds: z.number().int().min(1).max(3600).optional(),
});

function toFilter(v: unknown): CheckFilter {
    if (v === undefined || v === "all") return "all";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v as string[];
    return "all";
}

const filterSchema = {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { const: "all" }],
    description: "Check name filter: 'all' (default) or exact name(s)",
} as const;

export function createMcpServer(opts?: { bus?: EventBus; watchManager?: WatchManager }): Server {
    const bus = opts?.bus ?? new EventBus();
    const wm = opts?.watchManager ?? new WatchManager(bus);

    const server = new Server(
        { name: "agent-actions-await", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    const tools: Tool[] = [
        {
            name: "start_pr_watch",
            description:
                "Start watching a PR's checks. Returns handle immediately (universal, forward-compatible). Poll with get_pr_watch_status or use await_pr_actions for blocking.",
            inputSchema: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    repo: { type: "string" },
                    pr_number: { type: "number" },
                    filter: filterSchema as unknown as Record<string, unknown>,
                    timeout_seconds: {
                        type: "number",
                        description: "Timeout in seconds, default 600",
                    },
                },
                required: ["owner", "repo", "pr_number"],
            },
        },
        {
            name: "get_pr_watch_status",
            description:
                "Get status of a watch by handle. Returns pending/completed/timed_out with per-check results. After first read of completed/timed_out, handle is GC'd.",
            inputSchema: {
                type: "object",
                properties: { handle: { type: "string" } },
                required: ["handle"],
            },
        },
        {
            name: "await_pr_actions",
            description:
                "Blocking convenience wrapper: start watch and wait until all filtered checks settle or timeout (default 600s). Emits progress notifications if supported.",
            inputSchema: {
                type: "object",
                properties: {
                    owner: { type: "string" },
                    repo: { type: "string" },
                    pr_number: { type: "number" },
                    filter: filterSchema as unknown as Record<string, unknown>,
                    timeout_seconds: { type: "number" },
                },
                required: ["owner", "repo", "pr_number"],
            },
        },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (req, _extra) => {
        const { name, arguments: args } = req.params;
        try {
            switch (name) {
                case "start_pr_watch": {
                    const parsed = StartWatchInput.parse(args);
                    const handle = await wm.startWatch({
                        owner: parsed.owner,
                        repo: parsed.repo,
                        prNumber: parsed.pr_number,
                        ...(parsed.filter !== undefined ? { filter: toFilter(parsed.filter) } : {}),
                        ...(parsed.timeout_seconds !== undefined
                            ? { timeoutMs: parsed.timeout_seconds * 1000 }
                            : {}),
                    });
                    return { content: [{ type: "text", text: JSON.stringify({ handle }) }] };
                }
                case "get_pr_watch_status": {
                    const parsed = GetStatusInput.parse(args);
                    const st = wm.getStatus(parsed.handle);
                    if ("error" in st) {
                        return { content: [{ type: "text", text: JSON.stringify(st) }] };
                    }
                    return { content: [{ type: "text", text: JSON.stringify(st) }] };
                }
                case "await_pr_actions": {
                    const parsed = AwaitInput.parse(args);
                    const notify = (evt: {
                        name: string;
                        status: string;
                        conclusion: string | null;
                    }) => {
                        try {
                            const srv = server as unknown as {
                                notification: (n: unknown) => Promise<void>;
                            };
                            if (srv.notification) {
                                void srv.notification({
                                    method: "notifications/progress",
                                    params: {
                                        progress: 0,
                                        total: 1,
                                        message: `${evt.name}:${evt.status}:${evt.conclusion ?? ""}`,
                                    },
                                });
                            }
                        } catch {
                            // ignore
                        }
                    };
                    const res = await wm.awaitWatch(
                        {
                            owner: parsed.owner,
                            repo: parsed.repo,
                            prNumber: parsed.pr_number,
                            ...(parsed.filter !== undefined
                                ? { filter: toFilter(parsed.filter) }
                                : {}),
                            ...(parsed.timeout_seconds !== undefined
                                ? { timeoutMs: parsed.timeout_seconds * 1000 }
                                : {}),
                        },
                        notify,
                    );
                    return { content: [{ type: "text", text: JSON.stringify(res) }] };
                }
                default:
                    return {
                        content: [{ type: "text", text: `unknown tool: ${name}` }],
                        isError: true,
                    };
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
                isError: true,
            };
        }
    });

    return server;
}

export async function startStdio(opts?: {
    bus?: EventBus;
    watchManager?: WatchManager;
}): Promise<void> {
    const server = createMcpServer(opts);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
