import { describe, it, expect, vi } from "vitest";
import { EventBus, busKey, type NormalizedEvent } from "../src/bus.js";

function evt(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    owner: "acme",
    repo: "demo",
    sha: "abc123",
    type: "check_run",
    status: "completed",
    conclusion: "success",
    name: "ci",
    ...over,
  };
}

describe("busKey", () => {
  it("formats owner/repo@sha", () => {
    expect(busKey("o", "r", "s")).toBe("o/r@s");
  });
});

describe("EventBus", () => {
  it("publishes to only matching sha key, not others", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("acme", "demo", "sha-a", a);
    bus.subscribe("acme", "demo", "sha-b", b);
    bus.publish(evt({ sha: "sha-a", name: "a" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("supports many concurrent listeners on same key (200)", () => {
    const bus = new EventBus();
    const fns = Array.from({ length: 50 }, () => vi.fn());
    const unsubs = fns.map((fn) => bus.subscribe("acme", "demo", "abc123", fn));
    bus.publish(evt());
    for (const fn of fns) expect(fn).toHaveBeenCalledTimes(1);
    unsubs.forEach((u) => u());
    bus.publish(evt());
    for (const fn of fns) expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes handler", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe("acme", "demo", "abc123", fn);
    off();
    bus.publish(evt());
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listenerCount("acme", "demo", "abc123")).toBe(0);
  });

  it("subscribeAll receives every event regardless of key", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribeAll(fn);
    bus.publish(evt({ sha: "x" }));
    bus.publish(evt({ sha: "y" }));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    bus.publish(evt({ sha: "z" }));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waitFor resolves on predicate match", async () => {
    const bus = new EventBus();
    const p = bus.waitFor("acme", "demo", "abc123", (e) => e.name === "wanted", 1000);
    setTimeout(() => bus.publish(evt({ name: "other" })), 5);
    setTimeout(() => bus.publish(evt({ name: "wanted" })), 10);
    const got = await p;
    expect(got?.name).toBe("wanted");
  });

  it("waitFor times out returning null and cleans up handler", async () => {
    const bus = new EventBus();
    const got = await bus.waitFor("acme", "demo", "abc123", () => true, 15);
    expect(got).toBeNull();
    expect(bus.listenerCount("acme", "demo", "abc123")).toBe(0);
  });

  it("waitFor respects AbortSignal", async () => {
    const bus = new EventBus();
    const ac = new AbortController();
    const p = bus.waitFor("acme", "demo", "abc123", () => true, 5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    const got = await p;
    expect(got).toBeNull();
    expect(bus.listenerCount("acme", "demo", "abc123")).toBe(0);
  });

  it("waitFor cleans up after resolve so no leak", async () => {
    const bus = new EventBus();
    const p = bus.waitFor("acme", "demo", "abc123", () => true, 1000);
    bus.publish(evt());
    await p;
    expect(bus.listenerCount("acme", "demo", "abc123")).toBe(0);
  });

  it("removeAll clears all listeners", () => {
    const bus = new EventBus();
    bus.subscribe("acme", "demo", "a", vi.fn());
    bus.subscribeAll(vi.fn());
    bus.removeAll();
    expect(bus.listenerCount("acme", "demo", "a")).toBe(0);
  });

  it("publishes normalized shape keyed by baseOwner/baseRepo@sha (fork-safe)", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    // fork PR: base is acme/demo, head is fork/demo — bus should key by base
    bus.subscribe("acme", "demo", "forksha", fn);
    bus.publish(evt({ owner: "acme", repo: "demo", sha: "forksha" }));
    expect(fn).toHaveBeenCalledTimes(1);
    // different base should not receive
    bus.publish(evt({ owner: "fork", repo: "demo", sha: "forksha" }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
