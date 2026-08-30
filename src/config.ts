import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type RepoConfig = {
  owner: string;
  repo: string;
  hookId?: number;
  secretPath: string;
};

export type AppConfig = {
  port?: number; // 0 = random free (Q31)
  repos: RepoConfig[];
  pollGraceSeconds?: number; // Q18 global default 30
  pollIntervalSeconds?: number; // 15
  maxTimeoutSeconds?: number; // 600
  apiBase?: string; // optional override for GHE
};

export const DEFAULTS = {
  pollGraceSeconds: 30,
  pollIntervalSeconds: 15,
  maxTimeoutSeconds: 600,
} as const;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "agent-actions-await");
  if (env.AGENT_ACTIONS_AWAIT_CONFIG_DIR) return env.AGENT_ACTIONS_AWAIT_CONFIG_DIR;
  return join(homedir(), ".config", "agent-actions-await");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "secrets");
}

export function secretPathFor(owner: string, repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(secretsDir(env), `${owner}__${repo}.txt`);
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const p = configPath(env);
  if (!existsSync(p)) return { repos: [] };
  const raw = await readFile(p, "utf8");
  const j = JSON.parse(raw) as AppConfig;
  // minimal validation
  if (!Array.isArray(j.repos)) j.repos = [];
  return j;
}

export async function saveConfig(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true });
  const p = configPath(env);
  await writeFile(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await chmod(p, 0o600).catch(() => {});
}

export async function ensureSecret(owner: string, repo: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const sp = secretPathFor(owner, repo, env);
  if (existsSync(sp)) {
    const existing = (await readFile(sp, "utf8")).trim();
    if (existing.length >= 32) return sp;
  }
  const secret = randomBytes(32).toString("hex"); // 64 hex chars per Q34
  await mkdir(secretsDir(env), { recursive: true });
  await writeFile(sp, secret + "\n", "utf8");
  await chmod(sp, 0o600).catch(() => {});
  return sp;
}

export async function readSecret(owner: string, repo: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const sp = secretPathFor(owner, repo, env);
  if (!existsSync(sp)) return undefined;
  const raw = (await readFile(sp, "utf8")).trim();
  return raw || undefined;
}

export async function readSecretByPath(p: string): Promise<string | undefined> {
  if (!existsSync(p)) return undefined;
  const raw = (await readFile(p, "utf8")).trim();
  return raw || undefined;
}

/**
 * Hot-reload secrets: watcher can call getSecretFresh per request so rotation is immediate (Q40).
 */
export function makeSecretGetter(env: NodeJS.ProcessEnv = process.env): (owner: string, repo: string) => string | undefined {
  return (owner: string, repo: string): string | undefined => {
    try {
      const sp = secretPathFor(owner, repo, env);
      if (!existsSync(sp)) return undefined;
      const raw = readFileSync(sp, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  };
}
