import type { CommandRunner } from "./automation-driver-kit";

type JsonObject = Record<string, any>;

type LabelMove = {
  remove?: string | string[];
  add?: string | string[];
};

function labelArgs(move: LabelMove): string[] {
  const args: string[] = [];
  for (const label of [move.remove || []].flat()) {
    if (label) args.push("--remove-label", label);
  }
  for (const label of [move.add || []].flat()) {
    if (label) args.push("--add-label", label);
  }
  return args;
}

function createGithubOperations(commandRunner: CommandRunner) {
  return {
    listOpenIssues(repo: string): JsonObject[] {
      return commandRunner.runJson([
        "gh",
        "issue",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,body,labels,updatedAt,url",
      ]);
    },

    moveIssueLabels(repo: string, issueNumber: string | number, move: LabelMove): void {
      commandRunner.runText(["gh", "issue", "edit", String(issueNumber), "-R", repo, ...labelArgs(move)]);
    },

    commentIssue(repo: string, issueNumber: string | number, body: string): void {
      commandRunner.runText(["gh", "issue", "comment", String(issueNumber), "-R", repo, "--body", body]);
    },

    listOpenPrs(repo: string): JsonObject[] {
      return commandRunner.runJson([
        "gh",
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,url,updatedAt,headRefName,headRefOid,isCrossRepository,isDraft,mergeStateStatus,labels,statusCheckRollup,comments,reviewRequests",
      ]);
    },

    movePrLabels(repo: string, prNumber: string | number, move: LabelMove, options: { check?: boolean } = {}): void {
      commandRunner.runText(["gh", "pr", "edit", String(prNumber), "-R", repo, ...labelArgs(move)], { check: options.check });
    },

    commentPr(repo: string, prNumber: string | number, body: string): void {
      commandRunner.runText(["gh", "pr", "comment", String(prNumber), "-R", repo, "--body", body]);
    },

    addPrReviewer(repo: string, prNumber: string | number, reviewer: string, options: { check?: boolean } = {}): void {
      commandRunner.runText(["gh", "pr", "edit", String(prNumber), "-R", repo, "--add-reviewer", reviewer], { check: options.check });
    },
  };
}

module.exports = { createGithubOperations, labelArgs };
