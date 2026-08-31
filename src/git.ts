import { execSync } from "node:child_process";

export function parseRemoteUrl(remote: string): { owner: string; repo: string } | null {
    // Handles git@github.com:owner/repo.git, https://github.com/owner/repo.git, https://github.com/owner/repo
    const s = remote.trim();
    // scp-like
    const scp = s.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (scp) return { owner: scp[1]!, repo: scp[2]! };
    // https
    try {
        const u = new URL(s);
        const parts = u.pathname
            .replace(/^\/+/, "")
            .replace(/\.git$/, "")
            .split("/");
        if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
    } catch {}
    // fallback owner/repo
    const slash = s.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (slash) return { owner: slash[1]!, repo: slash[2]! };
    return null;
}

export function getGitRemoteOwnerRepo(cwd = process.cwd()): { owner: string; repo: string } | null {
    try {
        const out = execSync("git remote get-url origin", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return parseRemoteUrl(out);
    } catch {
        return null;
    }
}
