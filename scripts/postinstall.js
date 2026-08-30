#!/usr/bin/env node
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, platform as _platform, arch as _arch } from "node:os";

const VERSION = "2024.11.1";

function cacheDir() {
  return join(homedir(), ".cache", "agent-actions-await");
}
function binPath(dir = cacheDir()) {
  return join(dir, _platform() === "win32" ? "cloudflared.exe" : "cloudflared");
}
function downloadUrl(version = VERSION, plat = _platform(), arch = _arch()) {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${version}`;
  const triple = {
    linux: { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm" },
    darwin: { x64: "cloudflared-darwin-amd64", arm64: "cloudflared-darwin-amd64" },
    win32: { x64: "cloudflared-windows-amd64.exe", arm64: "cloudflared-windows-amd64.exe" },
  };
  const file = triple[plat]?.[arch] ?? "cloudflared-linux-amd64";
  return `${base}/${file}`;
}

async function main() {
  if (process.env.AGENT_ACTIONS_AWAIT_SKIP_POSTINSTALL === "1") {
    console.log("postinstall skipped (AGENT_ACTIONS_AWAIT_SKIP_POSTINSTALL=1)");
    return;
  }
  // If already in PATH, skip download
  const { execSync } = await import("node:child_process");
  try {
    execSync("cloudflared --version", { stdio: "ignore" });
    console.log("cloudflared already in PATH, skipping download");
    return;
  } catch {}

  const dir = cacheDir();
  const path = binPath(dir);
  if (existsSync(path)) {
    console.log(`cloudflared already cached at ${path}`);
    return;
  }

  const url = downloadUrl();
  console.log(`downloading cloudflared ${VERSION} from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`postinstall: download failed ${res.status} — will lazy-download on first start`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Best-effort: we don't have expected hash map baked; verify via content-length sanity
  if (buf.length < 1_000_000) {
    console.warn("postinstall: downloaded file suspiciously small, skipping cache — will retry on start");
    return;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, buf);
  await chmod(path, 0o755);
  console.log(`cached cloudflared to ${path}`);
}

main().catch((e) => {
  console.warn("postinstall warning:", e.message, "— will lazy-download on first start");
});
