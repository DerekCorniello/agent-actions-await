import { describe, it, expect } from "vitest";
import { parseRemoteUrl } from "../src/git.js";

describe("parseRemoteUrl", () => {
    it("parses git@ scp", () => {
        expect(parseRemoteUrl("git@github.com:acme/demo.git")).toEqual({
            owner: "acme",
            repo: "demo",
        });
        expect(parseRemoteUrl("git@github.com:acme/demo")).toEqual({ owner: "acme", repo: "demo" });
    });
    it("parses https", () => {
        expect(parseRemoteUrl("https://github.com/acme/demo.git")).toEqual({
            owner: "acme",
            repo: "demo",
        });
        expect(parseRemoteUrl("https://github.com/acme/demo")).toEqual({
            owner: "acme",
            repo: "demo",
        });
    });
    it("parses https with enterprise host", () => {
        expect(parseRemoteUrl("https://ghe.example.com/acme/demo.git")).toEqual({
            owner: "acme",
            repo: "demo",
        });
    });
    it("parses owner/repo directly", () => {
        expect(parseRemoteUrl("acme/demo")).toEqual({ owner: "acme", repo: "demo" });
    });
    it("returns null on garbage", () => {
        expect(parseRemoteUrl("not-a-url")).toBeNull();
        expect(parseRemoteUrl("")).toBeNull();
    });
});
