import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { platform, arch } from "node:os";

// Pinned version per Q41 — update via PR when new cloudflared stable
export const CLOUDFLARED_VERSION = "2024.11.1";
// Minimal checksum map for testability; production fills via postinstall fetch of release hashes
export const EXPECTED_SHA256: Record<string, string> = {
    // populated at build time by scripts/postinstall.js; empty here is okay for tests with injected expected
};

export type TunnelDeps = {
    execPathExists?: (path: string) => boolean | Promise<boolean>;
    spawnFn?: typeof spawn;
    fetchFn?: typeof fetch;
    platformFn?: () => NodeJS.Platform;
    archFn?: () => string;
    cacheDirFn?: () => string;
};

export function cloudflaredCacheDir(): string {
    return join(homedir(), ".cache", "agent-actions-await");
}

export function cloudflaredBinaryPath(cacheDir = cloudflaredCacheDir()): string {
    const base = join(cacheDir, "cloudflared");
    return platform() === "win32" ? base + ".exe" : base;
}

export function downloadUrl(version = CLOUDFLARED_VERSION, plat = platform(), a = arch()): string {
    const base = `https://github.com/cloudflare/cloudflared/releases/download/${version}`;
    // Map node plat/arch to cloudflared naming
    const triple: Record<string, Record<string, string>> = {
        linux: {
            x64: "cloudflared-linux-amd64",
            arm64: "cloudflared-linux-arm64",
            arm: "cloudflared-linux-arm",
        },
        darwin: { x64: "cloudflared-darwin-amd64", arm64: "cloudflared-darwin-amd64" },
        win32: { x64: "cloudflared-windows-amd64.exe", arm64: "cloudflared-windows-amd64.exe" },
    };
    const file = triple[plat]?.[a] ?? "cloudflared-linux-amd64";
    return `${base}/${file}`;
}

export async function isInPath(bin = "cloudflared", _deps?: TunnelDeps): Promise<string | null> {
    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
        exec(`${bin} --version`, (err) => {
            if (err) resolve(null);
            else resolve(bin);
        });
    });
}

export async function ensureCloudflared(
    opts: {
        version?: string;
        expectedSha256?: string;
        cacheDir?: string;
        deps?: TunnelDeps;
    } = {},
): Promise<string> {
    const deps = opts.deps ?? {};
    const cacheDir = opts.cacheDir ?? deps.cacheDirFn?.() ?? cloudflaredCacheDir();
    const binPath = cloudflaredBinaryPath(cacheDir);
    const inPath = await isInPath("cloudflared", deps);
    if (inPath) return inPath;

    if (existsSync(binPath)) {
        // verify existing binary hash if expected provided
        if (opts.expectedSha256) {
            const data = await readFile(binPath);
            const hash = createHash("sha256").update(data).digest("hex");
            if (hash !== opts.expectedSha256) {
                throw new Error(
                    `cloudflared checksum mismatch expected ${opts.expectedSha256} got ${hash}`,
                );
            }
        }
        return binPath;
    }

    // Download
    const url = downloadUrl(
        opts.version ?? CLOUDFLARED_VERSION,
        deps.platformFn?.() ?? platform(),
        deps.archFn?.() ?? arch(),
    );
    const fetchFn = deps.fetchFn ?? fetch;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`download cloudflared failed ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (opts.expectedSha256) {
        const hash = createHash("sha256").update(buf).digest("hex");
        if (hash !== opts.expectedSha256)
            throw new Error(
                `downloaded cloudflared checksum mismatch expected ${opts.expectedSha256} got ${hash}`,
            );
    }
    await mkdir(cacheDir, { recursive: true });
    await writeFile(binPath, buf);
    await chmod(binPath, 0o755);
    return binPath;
}

export type Tunnel = {
    url: string;
    proc: ChildProcess;
    stop(): void;
};

/**
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and resolves when trycloudflare.com URL appears on stdout.
 * Parses lines like `https://<random>.trycloudflare.com` from stderr/stdout per cloudflared quick tunnel.
 */
export async function startTunnel(
    port: number,
    binPath: string,
    deps?: TunnelDeps,
): Promise<Tunnel> {
    const spawnFn = deps?.spawnFn ?? spawn;
    const proc = spawnFn(binPath, ["tunnel", "--url", `http://localhost:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;

    const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        const onData = (chunk: Buffer) => {
            out += chunk.toString();
            const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
            if (m) {
                cleanup();
                resolve(m[0]);
            }
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const onExit = (code: number | null) => {
            cleanup();
            reject(
                new Error(`cloudflared exited ${code} before URL appeared: ${out.slice(0, 500)}`),
            );
        };
        const cleanup = () => {
            proc.stdout?.off("data", onData);
            proc.stderr?.off("data", onData);
            proc.off("error", onError);
            proc.off("exit", onExit);
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.once("error", onError);
        proc.once("exit", onExit);
        setTimeout(() => {
            cleanup();
            reject(new Error(`timeout waiting for cloudflared URL: ${out.slice(0, 500)}`));
        }, 30_000).unref?.();
    });

    return {
        url,
        proc,
        stop: () => {
            try {
                proc.kill();
            } catch {}
        },
    };
}
