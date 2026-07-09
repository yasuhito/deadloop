const {
  defaultIssueDecisionConfig,
  fixtureDecision,
  issueBlockedByNumbers,
  issueNumberForDecision,
  liveDependencyState,
  selectIssueForImplementation,
} = require("./issue-coordinator-decisions.ts");

type JsonObject = Record<string, any>;

type IssueCoordinatorFlowEnv = {
  readyLabel: string;
  implementLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  humanLabel: string;
  needsInfoLabel: string;
  wontfixLabel: string;
};

type IssueCoordinatorPlan =
  | { kind: "skip_no_candidate"; decision: JsonObject }
  | { kind: "contract_missing"; decision: JsonObject; issue: JsonObject }
  | { kind: "planning_blocked"; decision: JsonObject; issue: JsonObject }
  | { kind: "worker_required"; decision: JsonObject; issue: JsonObject };

const CONTRACT_BRIEF_RE = /^##\s*(?:Agent Brief|What to build)\b/im;
const CONTRACT_ACCEPTANCE_RE = /^##\s*(?:Acceptance criteria|受け入れ条件)\b|\bAcceptance criteria\b|受け入れ条件/im;
const PLANNING_TITLE_RE = /^\s*(?:PRD|RFC|設計|計画)\b/i;
const PLANNING_SECTION_RE = /^##\s*(?:PRD|RFC|設計|計画)\b/im;
const TASK_LIST_RE = /^\s*- \[[ xX]\] .+#\d+/m;

function issueDecisionConfig(env: IssueCoordinatorFlowEnv): JsonObject {
  return defaultIssueDecisionConfig({
    readyLabel: env.readyLabel,
    implementLabel: env.implementLabel,
    inProgressLabel: env.inProgressLabel,
    blockedLabel: env.blockedLabel,
    humanLabel: env.humanLabel,
    needsInfoLabel: env.needsInfoLabel,
    wontfixLabel: env.wontfixLabel,
  });
}

function decisionForIssues(fixturePath: string | undefined, issues: JsonObject[], repo: string, env: IssueCoordinatorFlowEnv): JsonObject {
  const config = issueDecisionConfig(env);
  if (fixturePath) return fixtureDecision(fixturePath, config);
  return selectIssueForImplementation(
    issues,
    config,
    (issue: JsonObject) => issueBlockedByNumbers(repo, issueNumberForDecision(issue)),
    (number: number) => liveDependencyState(repo, number),
  );
}

function selectedIssue(issues: JsonObject[], number: number): JsonObject {
  return issues.find((issue) => Number(issue.number || 0) === number) || { number, title: "", body: "", url: "" };
}

function hasImplementationContract(issue: JsonObject): boolean {
  const body = String(issue.body || "");
  return CONTRACT_BRIEF_RE.test(body) && CONTRACT_ACCEPTANCE_RE.test(body);
}

function isBlockedPlanningIssue(issue: JsonObject): boolean {
  const title = String(issue.title || "");
  const body = String(issue.body || "");
  return PLANNING_TITLE_RE.test(title) || PLANNING_SECTION_RE.test(body) || TASK_LIST_RE.test(body);
}

function planIssueCoordinatorAction(issues: JsonObject[], decision: JsonObject): IssueCoordinatorPlan {
  if (!decision.selected) return { kind: "skip_no_candidate", decision };

  const issue = selectedIssue(issues, Number(decision.number || 0));
  if (!hasImplementationContract(issue)) return { kind: "contract_missing", decision, issue };
  if (isBlockedPlanningIssue(issue)) return { kind: "planning_blocked", decision, issue };
  return { kind: "worker_required", decision, issue };
}

module.exports = {
  decisionForIssues,
  issueDecisionConfig,
  planIssueCoordinatorAction,
};
