import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/bus.js";
import { WatchManager } from "../src/watch-manager.js";
import type { NormalizedEvent } from "../src/bus.js";

function makeGhMocks(sha: string, checks: Array<{ name: string; status: string; conclusion: string | null }>) {
  const getPrHeadSha = vi.fn(async () => sha);
  const getChecks = vi.fn(async () => checks.map((c) => ({ ...c, sha })));
  return { getPrHeadSha, getChecks };
}

describe("WatchManager", () => {
  it("startWatch immediately completes if all checks settled", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "completed", conclusion: "success" }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 1000 });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "all" });
    const st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    expect(st.state).toBe("completed");
    expect(st.completed).toHaveLength(1);
  });

  it("startWatch pending then completes on bus event", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 1000 });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
    let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    expect(st.state).toBe("pending");
    bus.publish({ owner: "acme", repo: "demo", sha: "sha1", type: "check_run", status: "completed", conclusion: "success", name: "ci" } satisfies NormalizedEvent);
    // allow microtask
    await new Promise((r) => setTimeout(r, 10));
    st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("expected status");
    expect(st.state).toBe("completed");
  });

  it("dedups same sha+filter to same handle (Q27)", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks });
    const h1 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "all" });
    const h2 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "all" });
    expect(h1).toBe(h2);
    expect(wm.handleCount()).toBe(1);
  });

  it("different filter gets different handle", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks });
    const h1 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "ci" });
    const h2 = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "lint" });
    expect(h1).not.toBe(h2);
  });

  it("filter 'all' vs string: only wanted check drives completion", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [
      { name: "ci", status: "in_progress", conclusion: null },
      { name: "lint", status: "in_progress", conclusion: null },
    ]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, filter: "ci" });
    bus.publish({ owner: "acme", repo: "demo", sha: "sha1", type: "check_run", status: "completed", conclusion: "success", name: "lint" } as NormalizedEvent);
    await new Promise((r) => setTimeout(r, 10));
    let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("bad");
    expect(st.state).toBe("pending");
    bus.publish({ owner: "acme", repo: "demo", sha: "sha1", type: "check_run", status: "completed", conclusion: "success", name: "ci" } as NormalizedEvent);
    await new Promise((r) => setTimeout(r, 10));
    st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("bad");
    expect(st.state).toBe("completed");
  });

  it("times out with structured timed_out and partial results (Q20)", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 30 });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1, timeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    const st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("expected timed_out status not GC'd");
    expect(st.state).toBe("timed_out");
    expect(st.pending).toHaveLength(1);
  });

  it("GC after first read post-settled (Q37 fix): second get returns handle_not_found", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "completed", conclusion: "success" }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { gcAfterMs: 10000 });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
    const s1 = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    expect(s1.state).toBe("completed");
    const s2 = wm.getStatus(handle);
    expect((s2 as { error: string }).error).toBe("handle_not_found");
  });

  it("awaitWatch blocks and resolves on completion, with notifications (Q19 best-effort)", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 1000 });
    const notes: string[] = [];
    const p = wm.awaitWatch({ owner: "acme", repo: "demo", prNumber: 1 }, (e) => notes.push(e.name));
    setTimeout(() => bus.publish({ owner: "acme", repo: "demo", sha: "sha1", type: "check_run", status: "completed", conclusion: "success", name: "ci" } as NormalizedEvent), 20);
    const res = await p;
    expect(res.state).toBe("completed");
    expect(notes).toContain("ci");
  });

  it("awaitWatch times out returning timed_out (Q20)", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 1000 });
    const res = await wm.awaitWatch({ owner: "acme", repo: "demo", prNumber: 1, timeoutMs: 30 });
    expect(res.state).toBe("timed_out");
  });

  it("reset on new SHA via pull_request event (Q15) — new sha replaces watch", async () => {
    const bus = new EventBus();
    const sha1 = "sha1";
    const sha2 = "sha2";
    let currentSha = sha1;
    const getPrHeadSha = vi.fn(async () => currentSha);
    const getChecks = vi.fn(async ({ sha }: { sha: string }) => [{ name: "ci", status: "in_progress" as const, conclusion: null, sha }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks }, { defaultTimeoutMs: 1000 });
    const handle = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 42 });
    let st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    expect(st.sha).toBe("sha1");
    // simulate force-push: PR head moves to sha2
    currentSha = sha2;
    bus.publish({ owner: "acme", repo: "demo", sha: "sha2", type: "pull_request", status: "synchronize", conclusion: null, name: "pr:42" } as NormalizedEvent);
    await new Promise((r) => setTimeout(r, 30));
    st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("bad");
    expect(st.sha).toBe("sha2");
    // now complete new sha
    bus.publish({ owner: "acme", repo: "demo", sha: "sha2", type: "check_run", status: "completed", conclusion: "success", name: "ci" } as NormalizedEvent);
    await new Promise((r) => setTimeout(r, 10));
    st = wm.getStatus(handle) as import("../src/watch-manager.js").WatchStatus;
    if ("error" in st) throw new Error("bad");
    expect(st.state).toBe("completed");
  });

  it("close removes watch and clears timer", async () => {
    const bus = new EventBus();
    const { getPrHeadSha, getChecks } = makeGhMocks("sha1", [{ name: "ci", status: "in_progress", conclusion: null }]);
    const wm = new WatchManager(bus, { getPrHeadShaFn: getPrHeadSha as unknown as typeof getPrHeadSha, getChecksFn: getChecks as unknown as typeof getChecks });
    const h = await wm.startWatch({ owner: "acme", repo: "demo", prNumber: 1 });
    expect(wm.close(h)).toBe(true);
    expect((wm.getStatus(h) as { error: string }).error).toBe("handle_not_found");
    expect(wm.close(h)).toBe(false);
  });
});
