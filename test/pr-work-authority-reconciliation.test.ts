import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  applyPrWorkAuthorityReconciliation,
  postBlockRequestIsEligible,
  reconcilePrWorkAuthority,
  recoveryComment,
  requestAfterInvalidationCutoff,
} = require("../src/pr-work-authority-reconciliation.ts");

const {
  classifyClaim,
  latestConfiguredRequest,
  moveReconciledLabels,
  reconcile,
  reconciledLabelReplacement,
  reconciliationAuthorityMatches,
  replaceReconciledLabels,
  revalidatedMissingRecordClaimKind,
  revalidatedReplacedClaimKind,
  runtimeForAttempt,
} = require("../extensions/deadloop/automations/reconcile-pr-work-authority.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");

const claimBinding = {
  repositoryId: "repo-id", repository: "owner/repo", targetNumber: 42, requestEventId: "10", role: "reviewer",
  revision: "a".repeat(40), owner: "host:1", authority: { durationSeconds: 60 },
  activeState: {
    managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
    requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
  },
};
const reviewClaim = {
  binding: claimBinding, commentId: "100", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot",
  reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 55, cleanupGraceSeconds: 5, authoritySeconds: 60,
  reviewLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
};
const claimComment = {
  id: "100", author: { login: "deadloop-bot" }, createdAt: "2026-08-01T10:00:01Z", updatedAt: "2026-08-01T10:00:01Z",
  body: renderReviewClaimComment(claimBinding),
};

const base = {
  pr: {
    number: 42,
    headRefOid: "a".repeat(40),
    labels: ["agent:in-progress", "customer:keep"],
  },
  claim: { kind: "authorized" },
  runtime: { kind: "live_matching_owner" },
  requestEvents: [{ id: "10", event: "labeled", created_at: "2026-08-01T10:00:00Z", label: { name: "agent:review" } }],
  requestLabels: ["agent:update-branch", "agent:implement", "agent:review"],
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
};

/** Two authenticated block cycles on one head, so only the later cutoff still authorizes work. */
function twoBlockCycles(request: { id: string; created_at: string }) {
  const blockedEvent = (id: string, createdAt: string) => ({
    id, event: "labeled", created_at: createdAt, actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" },
  });
  const requestEvent = { ...request, event: "labeled", actor: { login: "human" }, label: { name: "agent:review" } };
  return {
    pr: base.pr,
    request: requestEvent,
    events: [blockedEvent("30", "2026-08-01T10:01:00Z"), requestEvent, blockedEvent("32", "2026-08-01T10:03:00Z")],
    comments: ["30", "32"].map((cutoffEventId) => ({
      author: { login: "deadloop-bot" },
      body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", cutoffEventId),
    })),
    authorizedLogins: ["deadloop-bot"],
    blockedLabel: "agent:blocked",
  };
}

// deadloop blocked the PR while its head was an earlier revision, so its one recovery marker names
// that revision rather than the head the PR carries now. Passing unauthenticated drops the blocked
// timeline event the marker points at, leaving the cutoff unproven.
function blockedOnAnEarlierRevision(options: { request?: { id: string; created_at: string }; unauthenticated?: boolean } = {}) {
  const cutoff = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
  const request = {
    ...(options.request || { id: "31", created_at: "2026-08-01T10:02:00Z" }),
    event: "labeled", actor: { login: "human" }, label: { name: "agent:review" },
  };
  return {
    pr: base.pr,
    request,
    events: options.unauthenticated ? [request] : [cutoff, request],
    comments: [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, "b".repeat(40), "claim_expired", "30") }],
    authorizedLogins: ["deadloop-bot"],
    blockedLabel: "agent:blocked",
  };
}

// The repair dispatcher stops a PR by adding agent:review and agent:blocked in one label move, so
// both land on the same GitHub timestamp and it explains itself without a work-authority marker.
// An older reconciler block on the same PR leaves the only marker.
function repairBlockedInOneOperation(options: { request?: { id: string; created_at: string } } = {}) {
  const blockedAt = "2026-08-01T10:03:00Z";
  const reconcilerBlock = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
  const repairBlock = { id: "42", event: "labeled", created_at: blockedAt, actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
  const request = {
    ...(options.request || { id: "43", created_at: blockedAt }),
    event: "labeled", actor: { login: "deadloop-bot" }, label: { name: "agent:review" },
  };
  return {
    pr: base.pr,
    request,
    events: [reconcilerBlock, repairBlock, request],
    comments: [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", "30") }],
    authorizedLogins: ["deadloop-bot"],
    blockedLabel: "agent:blocked",
  };
}

describe("PR work-authority reconciliation", () => {
  it("keeps a live matching claim unchanged", () => {
    expect(reconcilePrWorkAuthority(base).action).toBe("keep_active");
  });

  it("blocks an expired claim with one replacement label set", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "expired" } }).labels).toEqual(["customer:keep", "agent:blocked"]);
  });

  it("blocks missing claim evidence", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "missing" } }).action).toBe("block");
  });

  it("blocks malformed claim evidence", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "malformed" } }).reason).toBe("claim_malformed");
  });

  it("blocks unreachable runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "unreachable" } }).reason).toBe("runtime_unreachable");
  });

  it("reports unverifiable server time without calling a live owner stopped", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "server_time_unverifiable" } }).reason).toBe("server_time_unverifiable");
  });

  it("releases safely stopped owned runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "stopped_owned" } }).cleanup).toBe("close_owned_workspace");
  });

  it("preserves ambiguous runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "ambiguous" } }).cleanup).toBe("preserve_workspace");
  });

  it("keeps a queued request during normal supersession", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" } }).labels).toContain("agent:review");
  });

  it("does not release a live superseded owner", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" } }).action).toBe("keep_superseded");
  });

  it("releases a stopped superseded owner for its queued request", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } }).action).toBe("release_for_request");
  });

  it("removes the temporary block after safe supersession cleanup", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review", "agent:blocked"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } }).labels).not.toContain("agent:blocked");
  });

  it("preserves a superseding request when runtime ownership is ambiguous", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "ambiguous" } }).labels).toContain("agent:review");
  });

  it("invalidates a queued request during expiry", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "expired" } }).labels).not.toContain("agent:review");
  });

  it("orders a request before the blocked cutoff as invalid", () => {
    expect(requestAfterInvalidationCutoff(
      { id: "20", created_at: "2026-08-01T10:00:00Z" },
      { id: "21", created_at: "2026-08-01T10:00:00Z" },
    )).toBe(false);
  });

  it("orders a request after the blocked cutoff as eligible", () => {
    expect(requestAfterInvalidationCutoff(
      { id: "22", created_at: "2026-08-01T10:00:01Z" },
      { id: "21", created_at: "2026-08-01T10:00:00Z" },
    )).toBe(true);
  });

  it("selects a post-block request that follows a block deadloop never explained", () => {
    const cutoff = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
    const request = { id: "31", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments: [], authorizedLogins: ["deadloop-bot"], blockedLabel: "agent:blocked" })).toBe(true);
  });

  it("rejects a request the same operation added while blocking the PR", () => {
    expect(postBlockRequestIsEligible(repairBlockedInOneOperation())).toBe(false);
  });

  it("rejects a request that predates the newest block even when only an older one is explained", () => {
    expect(postBlockRequestIsEligible(repairBlockedInOneOperation({ request: { id: "41", created_at: "2026-08-01T10:02:00Z" } }))).toBe(false);
  });

  it("selects a request added after a block carrying no recovery marker", () => {
    expect(postBlockRequestIsEligible(repairBlockedInOneOperation({ request: { id: "44", created_at: "2026-08-01T10:05:00Z" } }))).toBe(true);
  });

  it("selects a post-block request bound by the recovery marker", () => {
    const cutoff = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
    const request = { id: "31", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    const comments = [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", "30") }];
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments, authorizedLogins: ["deadloop-bot"], blockedLabel: "agent:blocked" })).toBe(true);
  });

  it("validates a post-block request with a configured blocked label", () => {
    const cutoff = { id: "40", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "custom:blocked" } };
    const request = { id: "41", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    const comments = [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", "40") }];
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments, authorizedLogins: ["deadloop-bot"], blockedLabel: "custom:blocked" })).toBe(true);
  });

  it("rejects a request that follows only an obsolete blocked cutoff", () => {
    expect(postBlockRequestIsEligible(twoBlockCycles({ id: "31", created_at: "2026-08-01T10:02:00Z" }))).toBe(false);
  });

  it("selects a request that follows the latest blocked cutoff", () => {
    expect(postBlockRequestIsEligible(twoBlockCycles({ id: "33", created_at: "2026-08-01T10:04:00Z" }))).toBe(true);
  });

  it("selects a request added after a block the author has since pushed past", () => {
    expect(postBlockRequestIsEligible(blockedOnAnEarlierRevision())).toBe(true);
  });

  it("rejects a request that predates a block the author has since pushed past", () => {
    expect(postBlockRequestIsEligible(blockedOnAnEarlierRevision({ request: { id: "29", created_at: "2026-08-01T10:00:00Z" } }))).toBe(false);
  });

  it("rejects a post-block request while its bound blocked event stays unauthenticated", () => {
    expect(postBlockRequestIsEligible(blockedOnAnEarlierRevision({ unauthenticated: true }))).toBe(false);
  });

  it("does not reuse a blocked event from before an interrupted block transition", async () => {
    const result = await applyPrWorkAuthorityReconciliation(
      { ...base, pr: { ...base.pr, labels: ["agent:blocked", "customer:keep"] }, claim: { kind: "expired" } },
      {
        automationLogin: "deadloop-bot",
        blockStarted: { reason: "claim_expired", timelineEventIds: ["30"] },
        listTimelineEvents: () => [
          { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } },
        ],
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
      },
    );
    expect(result.action).toBe("blocked_cutoff_unproven");
  });

  it("creates one recovery comment across repeated reconciliation", async () => {
    const comments: Array<Record<string, unknown>> = [];
    const input = { ...base, pr: { ...base.pr, labels: [...base.pr.labels] }, claim: { kind: "expired" } };
    const operations = {
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => input.pr.labels.includes("agent:blocked") ? [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }] : [],
      listComments: () => comments,
      replaceLabels: (next: string[]) => { input.pr.labels = next; },
      comment: (body: string) => comments.push({ body, author: { login: "deadloop-bot" } }),
    };

    await applyPrWorkAuthorityReconciliation(input, operations);
    await applyPrWorkAuthorityReconciliation(input, operations);
    expect(comments).toHaveLength(1);
  });

  it("releases ownership only after an owned workspace closes", async () => {
    let released = false;
    const result = await applyPrWorkAuthorityReconciliation(
      { ...base, claim: { kind: "expired" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: (() => { let reads = 0; return () => ++reads === 1 ? [] : [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }]; })(),
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
        closeOwnedWorkspace: () => true,
        releaseLocalOwnership: () => { released = true; },
      },
    );
    expect({ released, cleanup: result.cleanup }).toEqual({ released: true, cleanup: "ownership_released" });
  });

  it("preserves ownership when an owned workspace does not close", async () => {
    const result = await applyPrWorkAuthorityReconciliation(
      { ...base, claim: { kind: "expired" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: (() => { let reads = 0; return () => ++reads === 1 ? [] : [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }]; })(),
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
        closeOwnedWorkspace: () => false,
      },
    );
    expect(result.cleanup).toBe("preserve_workspace");
  });

  it("does not expose a superseding request when workspace cleanup fails", async () => {
    let replaced = false;
    await applyPrWorkAuthorityReconciliation(
      { ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => [],
        listComments: () => [],
        replaceLabels: () => { replaced = true; },
        comment: () => {},
        closeOwnedWorkspace: () => false,
      },
    );
    expect(replaced).toBe(false);
  });

  it("retains local ownership when superseding-request exposure fails", async () => {
    let released = false;
    let message = "";
    try {
      await applyPrWorkAuthorityReconciliation(
        { ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } },
        {
          automationLogin: "deadloop-bot",
          listTimelineEvents: () => [],
          listComments: () => [],
          replaceLabels: () => { throw new Error("label failure"); },
          comment: () => {},
          recordReleaseStarted: () => {},
          closeOwnedWorkspace: () => true,
          releaseLocalOwnership: () => { released = true; },
        },
      );
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect({ message, released }).toEqual({ message: "label failure", released: false });
  });

  it("finishes local release when a retry finds the request already exposed", async () => {
    let released = false;
    await applyPrWorkAuthorityReconciliation(
      { ...base, pr: { ...base.pr, labels: ["customer:keep", "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => [],
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
        recordReleaseStarted: () => {},
        closeOwnedWorkspace: () => true,
        releaseLocalOwnership: () => { released = true; },
      },
    );
    expect(released).toBe(true);
  });

  it("journals and exposes a superseding request before terminal local release", async () => {
    const effects: string[] = [];
    await applyPrWorkAuthorityReconciliation(
      { ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => [],
        listComments: () => [],
        replaceLabels: () => { effects.push("labels"); },
        comment: () => {},
        recordReleaseStarted: () => { effects.push("journal"); },
        closeOwnedWorkspace: () => { effects.push("close"); return true; },
        releaseLocalOwnership: () => { effects.push("release"); },
      },
    );
    expect(effects).toEqual(["journal", "close", "labels", "release"]);
  });
});

/**
 * Runs the real reconciliation entrypoint against an expired reviewer claim whose workspace is
 * safely stopped, so the whole recovery path — request-invalidating label replacement, recovery
 * comment, workspace close, local release — executes against one live GitHub and runtime fake.
 */
async function runExpiredClaimReconciliation() {
  const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
  const originalPath = process.env.PATH;
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-expiry-recovery-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const stateDir = path.join(root, "deadloop");
  const runDir = path.join(stateDir, "runs", "attempt-1");
  const bin = path.join(root, "bin");
  try {
    for (const directory of [repo, worktree, bin, runDir]) mkdirSync(directory, { recursive: true });
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nprintf '{\"id\":\"repo-id\"}\\n'\n");
    execFileSync("chmod", ["+x", path.join(bin, "gh")]);
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PATH = `${bin}:${originalPath || ""}`;
    writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
      repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "repo-id", enabledAt: 1,
      automationLogin: "deadloop-bot",
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }] }));
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 42 }, inputRevision: { head: "a".repeat(40) },
      branch: "agent/issue-42", worktreePath: worktree, agentName: "dl-r-42-abcdef123456", workspaceLabel: "reviewer",
      promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
      workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
      phase: "agent_started", lastSuccessfulPhase: "agent_started", reviewClaim,
    }));

    let live = ["agent:in-progress", "agent:review", "customer:keep"];
    let workspaceOpen = true;
    const events: Array<Record<string, unknown>> = [
      { id: "10", event: "labeled", created_at: "2026-08-01T10:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
    ];
    const comments: Array<Record<string, unknown>> = [claimComment];
    const recoveryComments: string[] = [];
    const pr = () => ({ number: 42, state: "OPEN", headRefOid: "a".repeat(40), labels: live.map((name) => ({ name })) });
    // Another host queues a request after revalidation read the labels and before the recovery
    // mutation reaches GitHub. Its labeled event precedes the resulting blocked cutoff.
    const queueConcurrentRequest = () => { if (!live.includes("agent:implement")) live = [...live, "agent:implement"]; };
    const commandRunner = {
      runText: (argv: string[]) => {
        if (argv[0] === "herdr") { workspaceOpen = false; return ""; }
        if (argv[2] === "user") return "deadloop-bot\n";
        if (argv.slice(0, 3).join(" ") === "gh pr edit") {
          queueConcurrentRequest();
          const labelArgument = (flag: string) => argv.filter((_token, index) => argv[index - 1] === flag);
          const removed = labelArgument("--remove-label");
          live = [...live.filter((label) => !removed.includes(label)), ...labelArgument("--add-label").filter((label) => !live.includes(label))];
          return "";
        }
        return "date: Sat, 01 Aug 2026 10:01:01 GMT";
      },
      runJson: (argv: string[], options: { input?: string } = {}) => {
        const command = argv.slice(0, 3).join(" ");
        if (command === "herdr workspace list") return { result: { workspaces: workspaceOpen ? [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: worktree } }] : [] } };
        if (command === "herdr agent list") return { result: { agents: [] } };
        if (command === "herdr worktree list") return { result: { worktrees: [{ path: worktree }] } };
        if (command === "gh repo view") return { id: "repo-id", nameWithOwner: "owner/repo" };
        if (command === "gh pr list") return [pr()];
        if (command === "gh pr view") return pr();
        if (argv.includes("PUT")) {
          queueConcurrentRequest();
          live = JSON.parse(String(options.input || "{}")).labels;
          events.push({ id: "20", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } });
          return live.map((name) => ({ name }));
        }
        if (argv.includes("POST")) {
          const body = String(argv.at(-1) || "").replace(/^body=/, "");
          recoveryComments.push(body);
          comments.push({ id: "200", author: { login: "deadloop-bot" }, createdAt: "2026-08-01T10:02:01Z", updatedAt: "2026-08-01T10:02:01Z", body });
          return { id: "200" };
        }
        const endpoint = String(argv.at(-1) || "");
        if (endpoint.endsWith("/labels")) return [live.map((name) => ({ name }))];
        if (endpoint.endsWith("/events")) return [[...events]];
        if (endpoint.endsWith("/comments")) return [[...comments]];
        return [];
      },
    };
    await reconcile({
      projectRepo: repo, githubRepo: "owner/repo", stateDir, projectId: "demo",
      enabledAt: 1, automationLogin: "deadloop-bot",
    }, commandRunner);
    return { recoveryComments, labels: live, phase: JSON.parse(readFileSync(path.join(runDir, "attempt.json"), "utf8")).phase };
  } finally {
    if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("reconciliation entrypoint", () => {
  const authoritySnapshot = {
    state: "OPEN", headRefOid: "a".repeat(40), claimKind: "authorized",
    requestEventId: "10", managedLabels: ["agent:in-progress"],
  };
  const managedLabels = [...base.requestLabels, "agent:in-progress", "agent:blocked"];

  it("rejects a head race before a recovery mutation", () => {
    expect(reconciliationAuthorityMatches(authoritySnapshot, { ...authoritySnapshot, headRefOid: "b".repeat(40) })).toBe(false);
  });

  it("rejects a newly queued request generation before a recovery mutation", () => {
    expect(reconciliationAuthorityMatches(authoritySnapshot, { ...authoritySnapshot, claimKind: "superseded", requestEventId: "11", managedLabels: ["agent:in-progress", "agent:implement"] })).toBe(false);
  });

  it.each(["agent:review", "agent:implement", "agent:update-branch"])("invalidates a queued %s request observed immediately before claim expiry", (requestLabel) => {
    const events = [
      { id: "10", event: "labeled", created_at: "2026-08-01T10:00:00Z", label: { name: "agent:review" } },
      { id: "11", event: "labeled", created_at: "2026-08-01T10:00:59Z", label: { name: requestLabel } },
    ];
    expect(classifyClaim(
      { number: 42, state: "OPEN", headRefOid: "a".repeat(40), labels: ["agent:in-progress", requestLabel] },
      events, [claimComment], "date: Sat, 01 Aug 2026 10:01:01 GMT", { reviewClaim }, base.requestLabels,
      { id: "repo-id", nameWithOwner: "owner/repo" }, "owner/repo",
    ).claim.kind).toBe("expired");
  });

  it.each(["agent:implement", "agent:update-branch"])("recognizes a queued %s request as the latest generation", (requestLabel) => {
    expect(latestConfiguredRequest(
      [
        { id: "10", event: "labeled", created_at: "2026-08-01T10:00:00Z", label: { name: "agent:review" } },
        { id: "11", event: "labeled", created_at: "2026-08-01T10:01:00Z", label: { name: requestLabel } },
      ],
      ["agent:in-progress", requestLabel],
      base.requestLabels,
    )?.id).toBe("11");
  });

  it("refuses stopped ownership when the workspace has an extra pane", () => {
    const runner = {
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 2 }],
      listAgents: () => [],
      listWorktrees: () => [{ path: "/wt" }],
    };
    expect(runtimeForAttempt(runner, { workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }).kind).toBe("ambiguous");
  });

  it("refuses stopped ownership when another agent occupies a nested checkout path", () => {
    const runner = {
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 }],
      listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt/src", status: "working" }],
      listWorktrees: () => [{ path: "/wt" }],
    };
    expect(runtimeForAttempt(runner, { workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }).kind).toBe("ambiguous");
  });

  it("fails closed when the matching owner has an unknown status", () => {
    const runner = {
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 }],
      listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt/src", status: "paused-maybe" }],
      listWorktrees: () => [{ path: "/wt" }],
    };
    expect(runtimeForAttempt(runner, { workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }).kind).toBe("ambiguous");
  });

  it("refuses stopped ownership when another agent occupies the checkout", () => {
    const runner = {
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 }],
      listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }],
      listWorktrees: () => [{ path: "/wt" }],
    };
    expect(runtimeForAttempt(runner, { workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }).kind).toBe("ambiguous");
  });

  it("applies nested checkout occupancy proof when recovering a close receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-close-proof-"));
    try {
      writeFileSync(path.join(root, "authority-release-started.json"), JSON.stringify({
        schemaVersion: 1, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt",
      }));
      const runner = {
        listWorkspaces: () => [],
        listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt/src", status: "working" }],
        listWorktrees: () => [{ path: "/wt" }],
      };
      expect(runtimeForAttempt(runner, { runDir: root, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }, process.cwd()).kind).toBe("ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an unknown owner status while recovering a close receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-close-proof-"));
    try {
      writeFileSync(path.join(root, "authority-release-started.json"), JSON.stringify({
        schemaVersion: 1, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt",
      }));
      const runner = {
        listWorkspaces: () => [],
        listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt/src", status: "unknown" }],
        listWorktrees: () => [{ path: "/wt" }],
      };
      expect(runtimeForAttempt(runner, { runDir: root, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }, process.cwd()).kind).toBe("ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies checkout-wide agent proof when recovering a close receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-close-proof-"));
    try {
      writeFileSync(path.join(root, "authority-release-started.json"), JSON.stringify({
        schemaVersion: 1, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt",
      }));
      const runner = {
        listWorkspaces: () => [],
        listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }],
        listWorktrees: () => [{ path: "/wt" }],
      };
      expect(runtimeForAttempt(runner, { runDir: root, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner" }, process.cwd()).kind).toBe("ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a request added between revalidation and a supersession label mutation", () => {
    let live = ["agent:in-progress", "customer:keep"];
    const github = {
      movePrLabels: (_repository: string, _number: number, move: { remove: string[]; add: string[] }) => {
        live.push("agent:implement");
        live = live.filter((label) => !move.remove.includes(label));
        live.push(...move.add.filter((label) => !live.includes(label)));
      },
      listPrLabels: () => live.map((name) => ({ name })),
    };
    expect(moveReconciledLabels(github, "owner/repo", 42, [...live], ["agent:blocked"], managedLabels)).toContain("agent:implement");
  });

  it("invalidates a request added between revalidation and a request-invalidating mutation", () => {
    const revalidated = ["agent:in-progress", "customer:keep"];
    let live = [...revalidated, "agent:implement"];
    const github = {
      replacePrLabels: (_repository: string, _number: number, next: string[]) => { live = [...next]; },
      listPrLabels: () => live.map((name) => ({ name })),
    };
    expect(replaceReconciledLabels(github, "owner/repo", 42, revalidated, ["agent:blocked"], managedLabels)).not.toContain("agent:implement");
  });

  it("fails closed when a request survives a request-invalidating mutation", () => {
    const live = ["agent:in-progress", "customer:keep", "agent:implement"];
    const github = {
      replacePrLabels: () => {},
      listPrLabels: () => live.map((name) => ({ name })),
    };
    expect(() => replaceReconciledLabels(github, "owner/repo", 42, ["agent:in-progress", "customer:keep"], ["agent:blocked"], managedLabels))
      .toThrow("PR label recovery postcondition was not reached");
  });

  it("fails closed when a preserved unrelated label does not survive a request-invalidating mutation", () => {
    const github = {
      replacePrLabels: () => {},
      listPrLabels: () => [{ name: "agent:blocked" }],
    };
    expect(() => replaceReconciledLabels(github, "owner/repo", 42, ["agent:in-progress", "customer:keep"], ["agent:blocked"], managedLabels))
      .toThrow("PR label recovery postcondition was not reached");
  });

  it.each(["expired", "server_time_unverifiable", "missing", "malformed", "superseded"])("keeps a %s claim classification after the managed-label replacement", (claimKind) => {
    expect(revalidatedReplacedClaimKind(claimKind, true)).toBe(claimKind);
  });

  it("reclassifies an authorized claim as ambiguous after the managed-label replacement", () => {
    expect(revalidatedReplacedClaimKind("authorized", true)).toBe("ambiguous");
  });

  it("fails closed when a claim is inserted before a missing-record recovery mutation", () => {
    expect(revalidatedMissingRecordClaimKind("missing", [], [claimComment])).toBe("ambiguous");
  });

  it("preserves requested and concurrent unrelated labels while blocking ambiguous supersession", () => {
    expect(reconciledLabelReplacement(
      ["customer:concurrent", "agent:in-progress", "agent:review"],
      ["customer:old", "agent:review", "agent:blocked"],
      ["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"],
    )).toEqual(["customer:concurrent", "agent:review", "agent:blocked"]);
  });

  it("posts the recovery comment after an expiry label replacement", async () => {
    expect((await runExpiredClaimReconciliation()).recoveryComments).toHaveLength(1);
  });

  it("invalidates the queued request through the expiry label replacement", async () => {
    expect((await runExpiredClaimReconciliation()).labels).toEqual(["customer:keep", "agent:blocked"]);
  });

  it("releases local ownership after the expiry recovery comment", async () => {
    expect((await runExpiredClaimReconciliation()).phase).toBe("authority_released");
  });
});
