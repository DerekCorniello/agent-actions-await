import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { EventBus } from "../src/bus.js";
import { createHttpServer } from "../src/http-server.js";

const SECRET = "a".repeat(64);

function sig(body: Buffer): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("http-server", () => {
  it("GET /health returns ok", async () => {
    const bus = new EventBus();
    const { server, url } = await createHttpServer({ bus, getSecret: () => SECRET, port: 0 });
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
    server.close();
  });

  it("POST /webhook verifies HMAC and publishes to bus, single port random free (Q31)", async () => {
    const bus = new EventBus();
    let seen: string | null = null;
    bus.subscribe("acme", "demo", "sha123", (e) => (seen = e.name));
    const { server, url } = await createHttpServer({ bus, getSecret: (o, r) => (o === "acme" && r === "demo" ? SECRET : undefined), port: 0 });
    expect(url).toMatch(/127\.0\.0\.1/);
    const payload = { repository: { owner: { login: "acme" }, name: "demo" }, check_run: { head_sha: "sha123", status: "completed", conclusion: "success", name: "ci" } };
    const body = Buffer.from(JSON.stringify(payload));
    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "X-GitHub-Event": "check_run", "X-Hub-Signature-256": sig(body), "X-GitHub-Delivery": "d1", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(seen).toBe("ci");
    server.close();
  });

  it("POST /webhook rejects invalid signature with 401", async () => {
    const bus = new EventBus();
    const { server, url } = await createHttpServer({ bus, getSecret: () => SECRET, port: 0 });
    const body = Buffer.from(JSON.stringify({ repository: { owner: { login: "acme" }, name: "demo" }, check_run: { head_sha: "x", status: "completed", conclusion: "success", name: "ci" } }));
    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "X-GitHub-Event": "check_run", "X-Hub-Signature-256": "sha256=bad", "X-GitHub-Delivery": "d2", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it("unknown route 404", async () => {
    const bus = new EventBus();
    const { server, url } = await createHttpServer({ bus, getSecret: () => SECRET, port: 0 });
    const res = await fetch(`${url}/notfound`);
    expect(res.status).toBe(404);
    server.close();
  });

  it("dedup across requests: second delivery ignored but 200 (Q26)", async () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribeAll(() => count++);
    const { server, url } = await createHttpServer({ bus, getSecret: () => SECRET, port: 0 });
    const payload = { repository: { owner: { login: "acme" }, name: "demo" }, check_run: { head_sha: "s", status: "completed", conclusion: "success", name: "ci" } };
    const body = Buffer.from(JSON.stringify(payload));
    const headers = { "X-GitHub-Event": "check_run", "X-Hub-Signature-256": sig(body), "X-GitHub-Delivery": "dup-http", "content-type": "application/json" } as Record<string, string>;
    const r1 = await fetch(`${url}/webhook`, { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${url}/webhook`, { method: "POST", headers, body });
    expect(r2.status).toBe(200);
    expect(count).toBe(1);
    server.close();
  });
});
