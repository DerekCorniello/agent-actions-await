import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    configDir,
    configPath,
    secretsDir,
    secretPathFor,
    loadConfig,
    saveConfig,
    ensureSecret,
    readSecret,
    makeSecretGetter,
} from "../src/config.js";

function tempEnv() {
    const dir = mkdtempSync(join(tmpdir(), "aaw-test-"));
    const env = { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
    return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("config", () => {
    it("configDir respects XDG_CONFIG_HOME", () => {
        expect(configDir({ XDG_CONFIG_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
            "/tmp/x/agent-actions-await",
        );
        expect(configPath({ XDG_CONFIG_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
            "/tmp/x/agent-actions-await/config.json",
        );
        expect(secretsDir({ XDG_CONFIG_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
            "/tmp/x/agent-actions-await/secrets",
        );
        expect(secretPathFor("o", "r", { XDG_CONFIG_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(
            "/tmp/x/agent-actions-await/secrets/o__r.txt",
        );
    });

    it("loadConfig returns empty when missing", async () => {
        const { env, cleanup } = tempEnv();
        const cfg = await loadConfig(env);
        expect(cfg.repos).toEqual([]);
        cleanup();
    });

    it("save/load round-trip", async () => {
        const { env, cleanup } = tempEnv();
        await saveConfig(
            {
                repos: [{ owner: "acme", repo: "demo", secretPath: "/tmp/s" }],
                port: 0,
                pollGraceSeconds: 30,
            },
            env,
        );
        const loaded = await loadConfig(env);
        expect(loaded.repos[0]!.owner).toBe("acme");
        expect(loaded.port).toBe(0);
        cleanup();
    });

    it("ensureSecret creates 64 hex file 0600 and readSecret returns it", async () => {
        const { env, cleanup } = tempEnv();
        const sp = await ensureSecret("acme", "demo", env);
        const s = await readSecret("acme", "demo", env);
        expect(s).toMatch(/^[a-f0-9]{64}$/);
        expect(sp).toContain("acme__demo.txt");
        cleanup();
    });

    it("ensureSecret idempotent (doesn't overwrite existing)", async () => {
        const { env, cleanup } = tempEnv();
        const sp1 = await ensureSecret("acme", "demo", env);
        const s1 = await readSecret("acme", "demo", env);
        const sp2 = await ensureSecret("acme", "demo", env);
        const s2 = await readSecret("acme", "demo", env);
        expect(sp1).toBe(sp2);
        expect(s1).toBe(s2);
        cleanup();
    });

    it("makeSecretGetter hot-reloads after rotation (Q40)", async () => {
        const { env, cleanup } = tempEnv();
        await ensureSecret("acme", "demo", env);
        const getter = makeSecretGetter(env);
        const s1 = getter("acme", "demo");
        // rotate: overwrite file
        const { writeFileSync } = await import("node:fs");
        // write new secret
        const sp = secretPathFor("acme", "demo", env);
        writeFileSync(sp, "b".repeat(64) + "\n");
        const s2 = getter("acme", "demo");
        expect(s1).not.toBe(s2);
        expect(s2).toBe("b".repeat(64));
        cleanup();
    });
});
