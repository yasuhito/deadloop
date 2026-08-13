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

function createGithubOperations(commandRunner: CommandRunner, beforeMutation: () => void = () => {}) {
  return {
    getRepositoryIdentity(repo: string): JsonObject {
      return commandRunner.runJson(["gh", "repo", "view", repo, "--json", "id,nameWithOwner"]);
    },

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
        "number,title,body,labels,updatedAt,url,state,comments",
      ]);
    },

    getIssue(repo: string, issueNumber: string | number): JsonObject {
      return commandRunner.runJson([
        "gh", "issue", "view", String(issueNumber), "-R", repo,
        "--json", "number,title,body,labels,updatedAt,url,state,comments",
      ]);
    },

    moveIssueLabels(repo: string, issueNumber: string | number, move: LabelMove): void {
      beforeMutation();
      commandRunner.runText(["gh", "issue", "edit", String(issueNumber), "-R", repo, ...labelArgs(move)]);
    },

    commentIssue(repo: string, issueNumber: string | number, body: string): void {
      beforeMutation();
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
        "number,title,url,state,updatedAt,headRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,comments,reviewRequests",
      ]);
    },

    getPr(repo: string, prNumber: string | number): JsonObject {
      return commandRunner.runJson([
        "gh", "pr", "view", String(prNumber), "-R", repo,
        "--json", "number,title,url,state,updatedAt,headRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,comments,reviewRequests",
      ]);
    },

    movePrLabels(repo: string, prNumber: string | number, move: LabelMove, options: { check?: boolean } = {}): void {
      beforeMutation();
      commandRunner.runText(["gh", "pr", "edit", String(prNumber), "-R", repo, ...labelArgs(move)], { check: options.check });
    },

    replacePrLabels(repo: string, prNumber: string | number, labels: string[]): JsonObject {
      beforeMutation();
      return commandRunner.runJson([
        "gh", "api", "--method", "PUT", `repos/${repo}/issues/${prNumber}/labels`,
        "--input", "-",
      ], { input: JSON.stringify({ labels }) });
    },

    listPrLabels(repo: string, prNumber: string | number): JsonObject[] {
      const pages = commandRunner.runJson(["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues/${prNumber}/labels`]);
      return Array.isArray(pages) ? pages.flat() : [];
    },

    listPrTimelineEvents(repo: string, prNumber: string | number): JsonObject[] {
      const pages = commandRunner.runJson(["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues/${prNumber}/events`]);
      return Array.isArray(pages) ? pages.flat() : [];
    },

    listPrComments(repo: string, prNumber: string | number): JsonObject[] {
      const pages = commandRunner.runJson(["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues/${prNumber}/comments`]);
      return Array.isArray(pages) ? pages.flat() : [];
    },

    readRestResponseHeaders(repo: string): string {
      return commandRunner.runText(["gh", "api", "--include", `repos/${repo}`]);
    },

    createPrComment(repo: string, prNumber: string | number, body: string): JsonObject {
      beforeMutation();
      return commandRunner.runJson([
        "gh", "api", "--method", "POST", `repos/${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`,
      ]);
    },

    commentPr(repo: string, prNumber: string | number, body: string): string {
      beforeMutation();
      return commandRunner.runText(["gh", "pr", "comment", String(prNumber), "-R", repo, "--body", body]);
    },

    addPrReviewer(repo: string, prNumber: string | number, reviewer: string, options: { check?: boolean } = {}): void {
      beforeMutation();
      commandRunner.runText(["gh", "pr", "edit", String(prNumber), "-R", repo, "--add-reviewer", reviewer], { check: options.check });
    },
  };
}

module.exports = { createGithubOperations, labelArgs };
