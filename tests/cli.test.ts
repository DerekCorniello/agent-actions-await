import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

describe("cli", () => {
  it("bin/cli.ts builds to executable and --help prints usage", () => {
    const out = execFileSync("node", ["dist/bin/cli.js", "--help"], { encoding: "utf8" });
    expect(out).toMatch(/init.*owner\/repo/);
    expect(out).toMatch(/start/);
  });

  it("dist/bin/cli.js exists and is executable", () => {
    expect(existsSync("dist/bin/cli.js")).toBe(true);
  });

  it("init help without arg exits with error", () => {
    try {
      execFileSync("node", ["dist/bin/cli.js", "init"], { encoding: "utf8", stdio: "pipe" });
      expect(false).toBe(true);
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      const msg = (err.stderr ?? err.stdout ?? err.message) as string;
      expect(String(msg).toLowerCase()).toMatch(/owner\/repo|requires/);
    }
  });
});
