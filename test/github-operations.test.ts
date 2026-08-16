import { describe, expect, it } from "vitest";

const { createGithubOperations, labelArgs } = require("../src/github-operations.ts");

describe("GitHub operations", () => {
  it("builds label transition args", () => {
    expect(labelArgs({ remove: "agent:implement", add: "agent:blocked" })).toEqual([
      "--remove-label",
      "agent:implement",
      "--add-label",
      "agent:blocked",
    ]);
  });

  it("observes immutable repository identity", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), {}) });

    github.getRepositoryIdentity("owner/repo");

    expect(commands[0]).toEqual(["gh", "repo", "view", "owner/repo", "--json", "id,nameWithOwner"]);
  });

  it("lists open issues", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), []) });

    github.listOpenIssues("owner/repo");

    expect(commands[0]).toEqual([
      "gh",
      "issue",
      "list",
      "-R",
      "owner/repo",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,labels,updatedAt,url,state,comments",
    ]);
  });

  it("requests live PR mergeability for conflict recovery", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), []) });

    github.listOpenPrs("owner/repo");

    expect(commands[0].at(-1)).toContain("mergeable");
  });

  it("requests live PR merge state for conflict recovery", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), []) });

    github.listOpenPrs("owner/repo");

    expect(commands[0].at(-1)).toContain("mergeStateStatus");
  });

  it("moves issue labels", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: (args: string[]) => (commands.push(args), ""), runJson: () => [] });

    github.moveIssueLabels("owner/repo", 12, { remove: "agent:implement", add: "needs-triage" });

    expect(commands[0]).toEqual(["gh", "issue", "edit", "12", "-R", "owner/repo", "--remove-label", "agent:implement", "--add-label", "needs-triage"]);
  });

  it("adds one PR label without replacing the live label set", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), []) });

    github.addPrLabel("owner/repo", 24, "agent:in-progress");

    expect(commands[0]).toEqual([
      "gh", "api", "--method", "POST", "repos/owner/repo/issues/24/labels", "--input", "-",
    ]);
  });

  it("accepts the documented 200 response from one PR-label DELETE", () => {
    const github = createGithubOperations({ runText: () => "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n[]\n", runJson: () => [] });

    expect(github.deletePrLabel("owner/repo", 24, "agent:review").status).toBe(200);
  });

  it("returns a documented 404 PR-label DELETE response for fail-closed handling", () => {
    const github = createGithubOperations({ runText: () => "HTTP/2 404 Not Found\n", runJson: () => [] });

    expect(github.deletePrLabel("owner/repo", 24, "agent:review").status).toBe(404);
  });

  it("treats an ambiguous PR-label DELETE response as non-success", () => {
    const github = createGithubOperations({ runText: () => "[]\n", runJson: () => [] });

    expect(github.deletePrLabel("owner/repo", 24, "agent:review").status).toBe(0);
  });

  it("targets one encoded PR label for DELETE", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: (args: string[]) => (commands.push(args), "HTTP/2 200 OK\n"), runJson: () => [] });

    github.deletePrLabel("owner/repo", 24, "agent:review");

    expect(commands[0].at(-1)).toBe("repos/owner/repo/issues/24/labels/agent%3Areview");
  });

  it("paginates live PR labels", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: () => "", runJson: (args: string[]) => (commands.push(args), [[{ name: "one" }], [{ name: "two" }]]) });

    const labels = github.listPrLabels("owner/repo", 24);

    expect({ command: commands[0], labels }).toEqual({
      command: ["gh", "api", "--paginate", "--slurp", "repos/owner/repo/issues/24/labels"],
      labels: [{ name: "one" }, { name: "two" }],
    });
  });

  it("comments on PRs", () => {
    const commands: string[][] = [];
    const github = createGithubOperations({ runText: (args: string[]) => (commands.push(args), ""), runJson: () => [] });

    github.commentPr("owner/repo", 24, "body");

    expect(commands[0]).toEqual(["gh", "pr", "comment", "24", "-R", "owner/repo", "--body", "body"]);
  });
});
