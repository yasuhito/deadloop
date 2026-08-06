import { describe, expect, it } from "vitest";

const { addWorkerReviewLabel, assertWorkerPrBinding, assertWorkerPrReadyForReview, ensureWorkerPr } = require("../extensions/deadloop/automations/guarded-worker-pr.ts");

describe("guarded Worker PR binding", () => {
  it("rejects another GitHub repository before PR creation", () => {
    expect(() => assertWorkerPrBinding(
      { project: "demo", repository: "owner/repo" },
      { projectId: "demo", githubRepo: "other/repo" },
    )).toThrow("repository");
  });

  it("rejects another configured project before PR creation", () => {
    expect(() => assertWorkerPrBinding(
      { project: "demo", repository: "owner/repo" },
      { projectId: "other", githubRepo: "owner/repo" },
    )).toThrow("project");
  });

  it("rejects a recovered Worker PR with the wrong base branch before review", () => {
    const head = "a".repeat(40);
    expect(() => assertWorkerPrReadyForReview(
      { headRefName: "agent/issue-1", headRefOid: head, baseRefName: "wrong", closingIssuesReferences: [{ number: 1 }] },
      { branch: "agent/issue-1", baseBranch: "origin/main", target: { number: 1 } },
      head,
    )).toThrow("base branch");
  });

  it("rejects a recovered Worker PR without its Issue closing reference before review", () => {
    const head = "a".repeat(40);
    expect(() => assertWorkerPrReadyForReview(
      { headRefName: "agent/issue-1", headRefOid: head, baseRefName: "main", closingIssuesReferences: [] },
      { branch: "agent/issue-1", baseBranch: "origin/main", target: { number: 1 } },
      head,
    )).toThrow("does not close");
  });

  it("closes a newly created PR when its head races past the verified output", () => {
    const verifiedHead = "a".repeat(40); const racedHead = "b".repeat(40); const calls: string[] = [];
    const gh = (args: string[], json = false) => {
      calls.push(args.join(" "));
      if (args[1] === "list") return [];
      if (args[1] === "create") return "https://github.com/owner/repo/pull/17";
      if (args[1] === "view") return { headRefOid: racedHead };
      return json ? {} : "";
    };
    let error = "";
    try {
      ensureWorkerPr(
        { branch: "agent/issue-1", baseBranch: "origin/release", target: { number: 1 } },
        verifiedHead,
        { githubRepo: "owner/repo", title: "Task" },
        { remoteHead: () => verifiedHead, gh, recheck: () => {}, authorize: () => {} },
      );
    } catch (caught) { error = String(caught); }
    expect({ closed: calls.at(-1), error: error.includes("PR closed") }).toEqual({ closed: "pr close 17 -R owner/repo", error: true });
  });

  it("reauthorizes after the final label recheck", () => {
    const head = "a".repeat(40); let labeled = false; let error = "";
    try {
      addWorkerReviewLabel(
        17,
        { branch: "agent/issue-1", baseBranch: "origin/main", target: { number: 1 } },
        head,
        { githubRepo: "owner/repo", reviewLabel: "agent:review" },
        {
          recheck: () => {}, authorize: () => { throw new Error("stale_policy"); },
          gh: (args: string[]) => {
            if (args[1] === "view") return { headRefName: "agent/issue-1", headRefOid: head, baseRefName: "main", closingIssuesReferences: [{ number: 1 }] };
            if (args[1] === "edit") labeled = true;
          },
        },
      );
    } catch (caught) { error = String(caught); }
    expect({ labeled, stale: error.includes("stale_policy") }).toEqual({ labeled: false, stale: true });
  });

  it("reauthorizes after the final PR creation recheck", () => {
    const head = "a".repeat(40); let created = false;
    let error = "";
    try {
      ensureWorkerPr(
        { branch: "agent/issue-1", baseBranch: "origin/main", target: { number: 1 } },
        head,
        { githubRepo: "owner/repo", title: "Task" },
        {
          remoteHead: () => head,
          recheck: () => {},
          authorize: () => { throw new Error("stale_policy"); },
          gh: (args: string[]) => {
            if (args[1] === "list") return [];
            if (args[1] === "create") created = true;
            return "";
          },
        },
      );
    } catch (caught) { error = String(caught); }
    expect({ created, stale: error.includes("stale_policy") }).toEqual({ created: false, stale: true });
  });
});
