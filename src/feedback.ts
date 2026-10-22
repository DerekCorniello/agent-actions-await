export type FeedbackKind = "issue_comment" | "review_comment" | "review";

export type FeedbackItem = {
    id: string;
    kind: FeedbackKind;
    author: string;
    body: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    state?: string;
    path?: string;
    line?: number;
    commitId?: string;
};

/** Normalize REST or webhook payloads for issue comments, review comments, or submitted reviews. */
export function normalizeFeedback(kind: FeedbackKind, raw: unknown): FeedbackItem | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const rawId = value.id;
    const id =
        typeof rawId === "number" && Number.isSafeInteger(rawId)
            ? String(rawId)
            : typeof rawId === "string" && rawId.trim()
              ? rawId.trim()
              : undefined;
    const author = (value.user as Record<string, unknown> | undefined)?.login;
    const url = typeof value.html_url === "string" ? value.html_url : undefined;
    const rawCreatedAt = kind === "review" ? value.submitted_at : value.created_at;
    const rawUpdatedAt = kind === "review" ? value.submitted_at : value.updated_at;
    const createdAt = toIsoTimestamp(rawCreatedAt);
    const updatedAtCandidates = [toIsoTimestamp(rawUpdatedAt)];
    if (kind === "review_comment") {
        updatedAtCandidates.push(toIsoTimestamp(value.review_submitted_at));
    }
    const updatedAt = updatedAtCandidates
        .filter((timestamp): timestamp is string => timestamp !== undefined)
        .sort()
        .at(-1);

    if (!id || typeof author !== "string" || !author.trim() || !url || !createdAt || !updatedAt) {
        return null;
    }
    if (kind === "review" && (!isSubmittedReviewState(value.state) || !value.submitted_at))
        return null;

    return {
        id: `${kind}:${id}`,
        kind,
        author: author.trim(),
        body: typeof value.body === "string" ? value.body : "",
        url,
        createdAt,
        updatedAt,
        ...(typeof value.state === "string" ? { state: value.state } : {}),
        ...(typeof value.path === "string" ? { path: value.path } : {}),
        ...(typeof value.line === "number"
            ? { line: value.line }
            : typeof value.original_line === "number"
              ? { line: value.original_line }
              : {}),
        ...(typeof value.commit_id === "string" ? { commitId: value.commit_id } : {}),
    };
}

function isSubmittedReviewState(state: unknown): boolean {
    return (
        typeof state === "string" &&
        ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(state.toUpperCase())
    );
}

function toIsoTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
