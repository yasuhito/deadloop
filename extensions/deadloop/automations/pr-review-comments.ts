const { renderRepairMarker } = require("./pr-review-repair-state.ts");

type JsonObject = Record<string, any>;

const REVIEW_RESULT_RE = /<!--\s*deadloop:review-result\s+head=([0-9a-f]+)\s+review=([0-9a-f]+)\s+outcome=(approved|changes_requested|human_required)\s*-->/gi;
const REPAIR_RESULT_RE = /<!--\s*deadloop:review-repair-result\s+key=([0-9a-f]+)\s+head=([0-9a-f]+)\s*-->/gi;

const LOCAL_DETAIL_RE = /(?:\bfile:\/\/+|(?<!:)\/\/|\\\\)[^\s`'")]+|(?:^|[^A-Za-z0-9_/])(?:\/(?!\/)[^\s`'")]+|[A-Za-z]:\\)[^\s`'")]*/gi;
const INTERNAL_TERM_RE = /(?:worker|review-repair)-prompt(?:\.md)?|promise(?:\.json)?|(?:\.pi(?:-subagents)?|\.deadloop)[\\/][^\s`'")]*|[\\/]prompts?[\\/][^\s`'")]*|review-repair worker|deterministic dispatcher|\bherdr\b|\brunner\b|\bsession\b|\b[a-z0-9_.-]+-pr-\d+-(?:reviewer|review-repair(?:-[a-z0-9-]+)?)\b/gi;
const PROMPT_DETAIL_RE = /\bprompts?\b/i;
const INTERNAL_DETAIL_RE = new RegExp(`${LOCAL_DETAIL_RE.source}|(?:worker|review-repair)-prompt(?:\\.md)?|promise\\.json|(?:\\.pi(?:-subagents)?|\\.deadloop)[\\\\/]|[\\\\/]prompts?[\\\\/]|${PROMPT_DETAIL_RE.source}`, "i");
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const REPOSITORY_PATH_RE = /^(?!\.git(?:\/|$))(?!.*\/\/)[A-Za-z0-9._@+~/-]+$/;

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+!|])/g, "\\$1");
}

function publicText(value: unknown, fallback: string): string {
  const raw = String(value || "");
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || UNSAFE_CONTROL_RE.test(raw) || PROMPT_DETAIL_RE.test(text) || text.includes("<!-- deadloop:")) return fallback;
  const sanitized = text
    .replace(LOCAL_DETAIL_RE, (fragment) => `${fragment.startsWith(" ") ? " " : ""}[internal path omitted]`)
    .replace(INTERNAL_TERM_RE, "internal review data")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? escapeMarkdown(sanitized) : fallback;
}

function publicRepoPath(value: unknown): string {
  const raw = String(value || "");
  const candidate = raw.trim();
  if (!candidate || /[\u0000-\u001f\u007f-\u009f]/.test(raw) || !REPOSITORY_PATH_RE.test(candidate)) return "Not specified";
  const segments = candidate.split("/");
  if (
    candidate.startsWith("/")
    || candidate.startsWith("~")
    || segments.includes("..")
    || segments.some((segment) => [".pi", ".pi-subagents", ".deadloop"].includes(segment))
    || INTERNAL_DETAIL_RE.test(candidate)
  ) return "Not specified";
  return candidate;
}

function code(value: unknown): string {
  return `\`${String(value || "unknown").replace(/`/g, "")}\``;
}

function reviewMarker(input: JsonObject): string {
  return `<!-- deadloop:review-result head=${String(input.headOid).toLowerCase()} review=${String(input.reviewFingerprint).toLowerCase()} outcome=${input.outcome} -->`;
}

function additionalValidationSection(input: JsonObject): string {
  const validations = (input.additionalValidations || []).map(
    (validation: unknown) => `- ${publicText(validation, "Additional validation result omitted.")}`,
  );
  return validations.length
    ? `\n## Additional agent-reported validation\nThese results are informational and do not replace deadloop's required verification record.\n\n${validations.join("\n")}\n`
    : "";
}

/** Reads back the reviewer's disposition of the required findings raised earlier. */
const PRIOR_REQUIRED_FINDING_PROSE: Record<string, string> = {
  none: "No required finding existed before this review.",
  all_resolved: "Every earlier required finding is resolved.",
  persisted: "At least one earlier required finding is still unresolved.",
  regressed: "A previously resolved required finding came back.",
  mixed: "Earlier unresolved required findings stand next to new ones.",
};

/** Explains, in prose, why deadloop handed the result to a human instead of repairing it. */
const HUMAN_HANDOFF_PROSE: Record<string, string> = {
  reviewer_human_required: "The reviewer could not decide or repair this result inside the pull request.",
  prior_required_findings_persist: "Automatic repair did not start because an earlier required finding is still unresolved.",
  resolved_finding_regressed: "Automatic repair did not start because a previously resolved required finding came back.",
  prior_and_new_required_findings_mixed:
    "Automatic repair did not start because earlier unresolved required findings stand next to new ones.",
  repair_progress_not_reported:
    "Automatic repair did not start because the review did not report, in the required form, how the earlier required findings stand.",
};

function findingLocation(entry: JsonObject): string {
  const path = publicRepoPath(entry.path);
  return entry.line && path !== "Not specified" ? `${path}:${entry.line}` : path;
}

function renderRequiredFindings(input: JsonObject): string {
  return (input.findings || [])
    .map(
      (finding: JsonObject) =>
        `### ${publicText(finding.title, "Review finding")} — ${finding.severity || "unspecified"}\n- File: ${code(findingLocation(finding))}\n- Reason: ${publicText(finding.body, "The detailed evidence contained internal runtime information and was omitted.")}`,
    )
    .join("\n\n");
}

/** Advisory observations are shown for context only; they never reach automatic repair. */
function renderAdvisorySection(input: JsonObject): string {
  const advisories = (input.advisories || []).map(
    (advisory: JsonObject) =>
      `### ${publicText(advisory.title, "Advisory observation")}\n- File: ${code(findingLocation(advisory))}\n- Note: ${publicText(advisory.body, "The detailed note contained internal runtime information and was omitted.")}`,
  );
  if (!advisories.length) return "";
  return `\n## Advisory observations\nThese are optional. Automatic repair never changes code for them.\n\n${advisories.join("\n\n")}\n`;
}

function renderPriorFindingLine(input: JsonObject): string {
  const prose = PRIOR_REQUIRED_FINDING_PROSE[String(input.priorRequiredFindings || "")];
  return prose ? `\n- Earlier required findings: ${prose}` : "";
}

function renderChangesRequestedComment(input: JsonObject): string {
  const marker = input.repairBlocked ? "" : renderRepairMarker(input.headOid, input.reviewFingerprint);
  const nextStep = input.repairBlocked
    ? "Automatic repair did not start because required verification is blocked. Resolve the verification policy and use `/deadloop-doctor` before requeueing this PR."
    : input.repairAlreadyStarted
      ? "This exact review result already started its one automatic repair. The repair will not be launched again."
      : "Exactly one automatic repair for this review result will now start and will change only the findings listed above. The updated head will be reviewed again after a successful push.";
  return `## Review result: changes required

- Reviewed commit: ${code(input.headOid)}${renderPriorFindingLine(input)}
- Conclusion: The changes below must be addressed before this PR can proceed.

## Required findings

${renderRequiredFindings(input)}
${renderAdvisorySection(input)}
## Next step
${nextStep}
${additionalValidationSection(input)}
${reviewMarker({ ...input, outcome: "changes_requested" })}
${marker}`;
}

function renderApprovedReviewComment(input: JsonObject): string {
  return `## Review result: approved

- Reviewed commit: ${code(input.headOid)}
- Reason: ${publicText(input.summary || input.reason, "No actionable defects were found.")}
${renderAdvisorySection(input)}${additionalValidationSection(input)}
## Next step
The reviewed head is approved. The configured handoff or merge safety checks can continue.

${reviewMarker({ ...input, outcome: "approved" })}`;
}

function renderHumanRequiredComment(input: JsonObject): string {
  // The reviewer's own explanation is its summary; the reported result carries
  // no human-authored reason, so the transition supplies this sentence.
  const handoff = HUMAN_HANDOFF_PROSE[String(input.transitionReason || "")]
    || "The reviewer could not safely decide or repair this result.";
  const requiredFindings = (input.findings || []).length
    ? `\n## Required findings\n\n${renderRequiredFindings(input)}\n`
    : "";
  return `## Review result: human decision required

- Reviewed commit: ${code(input.headOid)}${renderPriorFindingLine(input)}
- Reason: ${handoff}
- Context: ${publicText(input.summary, "Review the findings and choose the safe next action.")}
${requiredFindings}${renderAdvisorySection(input)}${additionalValidationSection(input)}
## Recovery steps
Resolve the decision above, push a new commit if code changes are needed, then add ${code(input.reviewLabel || "agent:review")} so the new head can be reviewed.

${reviewMarker({ ...input, outcome: "human_required" })}`;
}

function renderRepairSuccessComment(input: JsonObject): string {
  const repairs = (input.repairs || []).map(
    (repair: JsonObject) =>
      `### ${publicText(repair.title, "Review finding")}\n- Changed: ${publicText(repair.summary, "The detailed repair summary contained internal runtime information and was omitted.")}\n- Files: ${(repair.paths || []).map(publicRepoPath).map(code).join(", ") || "None reported"}`,
  );
  const checks = (input.checks || []).map(
    (check: JsonObject) => `- ${code(publicText(check.command, "Configured project check"))}: ${check.result}`,
  );
  return `## Automatic review repair completed

- Review findings from: ${code(input.originalHeadOid)}
- New commit: ${code(input.newHeadOid)}

${repairs.join("\n\n")}

## Checks
${checks.join("\n")}

## Next step
The new head will be reviewed again. The review queue label remains in place while the prior in-progress state is released.

<!-- deadloop:review-repair-result key=${String(input.attemptKey).toLowerCase()} head=${String(input.newHeadOid).toLowerCase()} -->`;
}

function reviewCommentExists(comments: JsonObject[], headOid: string, reviewFingerprint: string, outcome: string): boolean {
  return (comments || []).some((comment) => {
    REVIEW_RESULT_RE.lastIndex = 0;
    return Array.from(String(comment?.body || "").matchAll(REVIEW_RESULT_RE)).some(
      (match) => match[1].toLowerCase() === headOid.toLowerCase() && match[2].toLowerCase() === reviewFingerprint.toLowerCase() && match[3] === outcome,
    );
  });
}

function repairResultCommentExists(comments: JsonObject[], attemptKey: string, headOid: string, authorLogin: string): boolean {
  return (comments || []).some((comment) => {
    if (String(comment?.author?.login || "").toLowerCase() !== authorLogin.toLowerCase()) return false;
    REPAIR_RESULT_RE.lastIndex = 0;
    return Array.from(String(comment?.body || "").matchAll(REPAIR_RESULT_RE)).some(
      (match) =>
        match[1].toLowerCase() === attemptKey.toLowerCase()
        && match[2].toLowerCase() === headOid.toLowerCase(),
    );
  });
}

module.exports = {
  renderApprovedReviewComment,
  renderChangesRequestedComment,
  renderHumanRequiredComment,
  renderRepairSuccessComment,
  publicText,
  repairResultCommentExists,
  reviewCommentExists,
};
