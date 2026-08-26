const {
  defaultDecisionConfig,
  externalReviewGate: decideExternalReviewGate,
  selectPrRequestTarget,
  attemptJournalsForPrReviewer,
  workingReviewerPrNumbers,
} = require("./pr-reviewer-decisions.cts");

type JsonObject = Record<string, any>;

type PrRequestFlowEnv = {
  projectId: string;
  githubRepo: string;
  automationLogin: string;
  stateDir: string;
  reviewLabel: string;
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  autoMerge: boolean;
  externalReviewEnabled: boolean;
  externalReviewWaitSeconds: string;
  now: string;
};

type PrRequestPlan =
  | { kind: "skip_no_candidate"; summary: string; driverAction: "no_candidate"; decision: JsonObject }
  | { kind: "skip_wait"; summary: string; driverAction: "wait"; decision: JsonObject }
  | { kind: "branch_update_required"; decision: JsonObject; pr: JsonObject }
  | { kind: "repair_request_required"; decision: JsonObject; pr: JsonObject }
  | { kind: "external_review_request"; decision: JsonObject; pr: JsonObject; gate: JsonObject }
  | { kind: "external_review_wait"; decision: JsonObject; pr: JsonObject; gate: JsonObject }
  | { kind: "review_required"; decision: JsonObject; pr: JsonObject; gate: JsonObject; reason: string };

function decisionConfig(env: PrRequestFlowEnv): JsonObject {
  const externalReviewWaitSeconds = Number(env.externalReviewWaitSeconds || 1800);
  if (!Number.isFinite(externalReviewWaitSeconds) || externalReviewWaitSeconds < 0) {
    throw new Error("DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS must be a non-negative number");
  }
  if (env.now && !/^\d{4}-\d{2}-\d{2}T/.test(env.now)) throw new Error("DEADLOOP_NOW must be an ISO-8601 timestamp");
  const now = env.now ? new Date(env.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("DEADLOOP_NOW must be an ISO-8601 timestamp");
  return defaultDecisionConfig({
    reviewLabel: env.reviewLabel,
    implementLabel: env.implementLabel || "agent:implement",
    updateBranchLabel: env.updateBranchLabel || "agent:update-branch",
    inProgressLabel: env.inProgressLabel || "agent:in-progress",
    blockedLabel: env.blockedLabel,
    autoMerge: env.autoMerge,
    externalReviewEnabled: env.externalReviewEnabled,
    externalReviewWaitSeconds,
    projectId: env.projectId,
    automationLogin: env.automationLogin,
    now,
  });
}

function hasSkippedReason(decision: JsonObject, reasons: string[]): boolean {
  const wanted = new Set(reasons);
  return (decision.skipped || []).some((entry: JsonObject) => wanted.has(String(entry.reason || "")));
}

function selectedPr(prs: JsonObject[], number: number): JsonObject {
  return prs.find((pr) => Number(pr.number) === number) || { number };
}

function planPrRequestAction(prs: JsonObject[], _agents: JsonObject, env: PrRequestFlowEnv): PrRequestPlan {
  const config = decisionConfig(env);
  const attempts = env.stateDir ? attemptJournalsForPrReviewer(env.stateDir) : [];
  const decision = selectPrRequestTarget(
    prs,
    config,
    workingReviewerPrNumbers(_agents, env.projectId, attempts, env.githubRepo || ""),
  );

  if (!decision.selected) {
    if (hasSkippedReason(decision, ["pending_checks", "external_review_wait"])) {
      return {
        kind: "skip_wait",
        summary: "PR reviewer is waiting for checks or external review",
        driverAction: "wait",
        decision,
      };
    }
    return { kind: "skip_no_candidate", summary: "No target PR", driverAction: "no_candidate", decision };
  }

  const pr = selectedPr(prs, Number(decision.number));
  if (decision.role === "branch-update") return { kind: "branch_update_required", decision, pr };
  // A repair request skips the review-only gates on purpose: an unrepaired head is a state no
  // check result or external review can make reviewable, so waiting would only delay recovery.
  if (decision.role === "review-repair") return { kind: "repair_request_required", decision, pr };

  if (!env.externalReviewEnabled) {
    return {
      kind: "review_required",
      decision,
      pr,
      gate: { action: "disabled" },
      reason: String(decision.reason || "external_review_disabled"),
    };
  }

  const gate = decideExternalReviewGate(pr, config);
  if (gate.action === "request_external_review") return { kind: "external_review_request", decision, pr, gate };
  if (gate.action === "wait_external_review") return { kind: "external_review_wait", decision, pr, gate };

  return {
    kind: "review_required",
    decision,
    pr,
    gate,
    reason: String(decision.reason || "review_required"),
  };
}

module.exports = { planPrRequestAction, decisionConfig };
