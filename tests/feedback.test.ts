import { describe, expect, it } from "vitest";
import { normalizeFeedback, type FeedbackKind } from "../src/feedback.js";

const base = {
    id: 17,
    user: { login: "octocat" },
    body: "A note",
    html_url: "https://github.test/feedback/17",
};

describe("normalizeFeedback", () => {
    it("normalizes issue comments with created and updated timestamps", () => {
        expect(
            normalizeFeedback("issue_comment", {
                ...base,
                created_at: "2026-01-02T03:04:05Z",
                updated_at: "2026-01-02T04:04:05Z",
            }),
        ).toEqual({
            id: "issue_comment:17",
            kind: "issue_comment",
            author: "octocat",
            body: "A note",
            url: "https://github.test/feedback/17",
            createdAt: "2026-01-02T03:04:05.000Z",
            updatedAt: "2026-01-02T04:04:05.000Z",
        });
    });

    it("normalizes inline review metadata and stable IDs", () => {
        expect(
            normalizeFeedback("review_comment", {
                ...base,
                path: "src/main.ts",
                line: 12,
                commit_id: "sha123",
                created_at: "2026-01-02T03:04:05Z",
                updated_at: "2026-01-02T04:04:05Z",
            }),
        ).toMatchObject({
            id: "review_comment:17",
            path: "src/main.ts",
            line: 12,
            commitId: "sha123",
        });
    });

    it("uses original_line when a review comment is outdated", () => {
        expect(
            normalizeFeedback("review_comment", {
                ...base,
                original_line: 7,
                created_at: "2026-01-02T03:04:05Z",
                updated_at: "2026-01-02T04:04:05Z",
            }),
        ).toMatchObject({ line: 7 });
    });

    it("keeps a later edit timestamp after the review was submitted", () => {
        expect(
            normalizeFeedback("review_comment", {
                ...base,
                created_at: "2026-01-02T03:04:05Z",
                updated_at: "2026-01-05T03:04:05Z",
                review_submitted_at: "2026-01-04T03:04:05Z",
            }),
        ).toMatchObject({
            createdAt: "2026-01-02T03:04:05.000Z",
            updatedAt: "2026-01-05T03:04:05.000Z",
        });
    });

    it("uses submitted_at for both review timestamps", () => {
        expect(
            normalizeFeedback("review", {
                ...base,
                state: "CHANGES_REQUESTED",
                submitted_at: "2026-01-02T03:04:05Z",
                commit_id: "sha123",
            }),
        ).toMatchObject({
            id: "review:17",
            kind: "review",
            state: "CHANGES_REQUESTED",
            createdAt: "2026-01-02T03:04:05.000Z",
            updatedAt: "2026-01-02T03:04:05.000Z",
            commitId: "sha123",
        });
        expect(
            normalizeFeedback("review", {
                ...base,
                state: "COMMENTED",
                submitted_at: "2026-01-02T03:04:05Z",
            }),
        ).toMatchObject({ state: "COMMENTED" });
    });

    it("ignores pending reviews and malformed feedback", () => {
        expect(normalizeFeedback("review", { ...base, state: "PENDING" })).toBeNull();
        expect(normalizeFeedback("review", { ...base, state: "COMMENTED" })).toBeNull();
        expect(
            normalizeFeedback("review", {
                ...base,
                state: "DISMISSED",
                submitted_at: "2026-01-02T03:04:05Z",
            }),
        ).toBeNull();
        expect(
            normalizeFeedback("review", {
                ...base,
                state: "UNKNOWN",
                submitted_at: "2026-01-02T03:04:05Z",
            }),
        ).toBeNull();
        expect(
            normalizeFeedback("review", { ...base, submitted_at: "2026-01-02T03:04:05Z" }),
        ).toBeNull();
        const kinds: FeedbackKind[] = ["issue_comment", "review_comment", "review"];
        for (const kind of kinds) {
            expect(normalizeFeedback(kind, null)).toBeNull();
            expect(normalizeFeedback(kind, { ...base, id: undefined })).toBeNull();
            expect(normalizeFeedback(kind, { ...base, user: null })).toBeNull();
            expect(normalizeFeedback(kind, { ...base, html_url: undefined })).toBeNull();
            expect(
                normalizeFeedback(kind, {
                    ...base,
                    created_at: "not a date",
                    updated_at: "not a date",
                    submitted_at: "not a date",
                }),
            ).toBeNull();
        }
    });
});
