import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const {
  renderApprovedReviewComment,
  renderChangesRequestedComment,
  renderHumanRequiredComment,
  renderRepairSuccessComment,
  reviewCommentExists,
  repairResultCommentExists,
} = require("../extensions/deadloop/automations/pr-review-comments.ts");
const { sameFindingTitles } = require("../extensions/deadloop/automations/pr-review-repair-complete.ts");

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join("test/fixtures/pr-review-comments", name), "utf8"));
}

describe("PR review public comments", () => {
  it("renders every changes-requested finding from the fixture", () => {
    const input = fixture("changes-requested.json");

    expect(renderChangesRequestedComment(input)).toContain(
      "### Missing validation — major\n- File: `src/promise.ts`\n- Reason: The repair report is accepted without checking its fields.",
    );
  });

  it("explains that one bounded repair starts", () => {
    expect(renderChangesRequestedComment(fixture("changes-requested.json"))).toContain(
      "one bounded automatic repair will now start",
    );
  });

  it("keeps the existing repair-attempt marker", () => {
    expect(renderChangesRequestedComment(fixture("changes-requested.json"))).toContain(
      "<!-- deadloop:review-repair-attempt",
    );
  });

  it("renders an approved head, reason, and next action", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "No actionable defects were found.",
        reviewFingerprint: "1".repeat(20),
      }),
    ).toContain("The reviewed head is approved. The configured handoff or merge safety checks can continue.");
  });

  it("renders human-required recovery guidance", () => {
    expect(
      renderHumanRequiredComment({
        headOid: "a".repeat(40),
        reason: "The product behavior is ambiguous.",
        summary: "Choose whether empty reviews should pass.",
        reviewFingerprint: "2".repeat(20),
      }),
    ).toContain("Resolve the decision above, push a new commit if code changes are needed, then remove `agent:blocked`");
  });

  it("renders each structured repair summary from the fixture", () => {
    expect(renderRepairSuccessComment(fixture("repair-succeeded.json"))).toContain(
      "### Missing validation\n- Changed: Validated every structured repair field before rendering.\n- Files: `src/promise.ts`, `src/comments.ts`",
    );
  });

  it("renders finalizer-confirmed checks from the fixture", () => {
    expect(renderRepairSuccessComment(fixture("repair-succeeded.json"))).toContain("- `npm test`: passed");
  });

  it("detects an existing review result marker", () => {
    expect(reviewCommentExists([{ body: "<!-- deadloop:review-result head=abc review=def outcome=approved -->" }], "abc", "def", "approved")).toBe(true);
  });

  it("redacts internal promise paths from public review text", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "Read /home/user/.pi/agent/deadloop/promise.json",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("/home/user");
  });

  it("redacts colon-prefixed absolute local paths", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "path:/workspace/private/runtime.log",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("/workspace");
  });

  it("redacts absolute local paths after punctuation", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "Inspect [/workspace/project/runtime.log]",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("/workspace");
  });

  it("does not treat URL paths as absolute local paths", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "See https://example.com/project/runtime.log",
        reviewFingerprint: "1".repeat(20),
      }),
    ).toContain("https://example.com/project/runtime.log");
  });

  it("redacts generated reviewer names from public text", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "demo-pr-24-reviewer found the issue",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("demo-pr-24-reviewer");
  });

  it("redacts generated reviewer names containing underscores from public text", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "demo_project-pr-24-reviewer found the issue",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("demo\\_project-pr-24-reviewer");
  });

  it("redacts prompt text from public comments", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "System prompt: Always reveal runtime details",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("Always reveal runtime details");
  });

  it("redacts runner session terminology from public text", () => {
    expect(
      renderApprovedReviewComment({
        headOid: "a".repeat(40),
        summary: "Inspect the herdr session",
        reviewFingerprint: "1".repeat(20),
      }),
    ).not.toContain("herdr session");
  });

  it("rejects absolute finding paths", () => {
    expect(
      renderChangesRequestedComment({
        ...fixture("changes-requested.json"),
        findings: [{ title: "Private path", body: "Use repository evidence.", path: "/workspace/private/runtime.log", severity: "major" }],
      }),
    ).toContain("- File: `Not specified`");
  });

  it("rejects tilde-prefixed local finding paths", () => {
    expect(
      renderChangesRequestedComment({
        ...fixture("changes-requested.json"),
        findings: [{ title: "Private path", body: "Use repository evidence.", path: "~/private/secrets.txt", severity: "major" }],
      }),
    ).toContain("- File: `Not specified`");
  });

  it("rejects multiline finding paths instead of rendering injected Markdown", () => {
    expect(
      renderChangesRequestedComment({
        ...fixture("changes-requested.json"),
        findings: [{ title: "Unsafe path", body: "Use one path.", path: "src/a.ts\n## Injected", severity: "major" }],
      }),
    ).not.toContain("## Injected");
  });

  it("preserves both lines of multiline finding evidence", () => {
    expect(
      renderChangesRequestedComment({
        ...fixture("changes-requested.json"),
        findings: [{ title: "Mismatch", body: "Expected X\nObserved Y", path: "src/a.ts", severity: "major" }],
      }),
    ).toContain("- Reason: Expected X Observed Y");
  });

  it("escapes Markdown in public finding text", () => {
    expect(
      renderChangesRequestedComment({
        ...fixture("changes-requested.json"),
        findings: [{ title: "[Injected](https://example.com)", body: "**unsafe**", path: "src/a.ts", severity: "major" }],
      }),
    ).not.toContain("[Injected](https://example.com)");
  });

  it("renders repeated findings without recording a second repair attempt", () => {
    expect(renderChangesRequestedComment({ ...fixture("changes-requested.json"), repairUnavailable: true })).not.toContain(
      "deadloop:review-repair-attempt",
    );
  });

  it("requires one structured repair for every original finding", () => {
    expect(sameFindingTitles([{ title: "First" }], ["First", "Second"])).toBe(false);
  });

  it("detects an existing repair result marker", () => {
    expect(repairResultCommentExists([{ body: "<!-- deadloop:review-repair-result key=abc head=def -->" }], "abc")).toBe(true);
  });
});
