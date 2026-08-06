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

function renderChangesRequestedComment(input: JsonObject): string {
  const findings = (input.findings || []).map((finding: JsonObject) => {
    const path = publicRepoPath(finding.path);
    const location = finding.line && path !== "Not specified" ? `${path}:${finding.line}` : path;
    return `### ${publicText(finding.title, "Review finding")} — ${finding.severity || "unspecified"}\n- File: ${code(location)}\n- Reason: ${publicText(finding.body, "The detailed evidence contained internal runtime information and was omitted.")}`;
  });
  const marker = renderRepairMarker(input.headOid, input.reviewFingerprint);
  const nextStep = input.repairUnavailable
    ? "The same findings remained after their one bounded automatic repair attempt. Automatic repair will not run again; inspect the current head, correct the branch without rewriting history, push a new commit, then remove `agent:blocked`."
    : input.repairAlreadyStarted
      ? "This review result already used its one bounded automatic repair attempt. The repair will not be launched again."
      : "Exactly one bounded automatic repair will now start and will change only the findings listed above. The updated head will be reviewed again after a successful push.";
  const nextHeading = input.repairUnavailable ? "Recovery steps" : "Next step";
  return `## Review result: changes required

- Reviewed commit: ${code(input.headOid)}
- Conclusion: The changes below must be addressed before this PR can proceed.

${findings.join("\n\n")}

## ${nextHeading}
${nextStep}

${reviewMarker({ ...input, outcome: "changes_requested" })}${input.repairUnavailable ? "" : `\n${marker}`}`;
}

function renderApprovedReviewComment(input: JsonObject): string {
  return `## Review result: approved

- Reviewed commit: ${code(input.headOid)}
- Reason: ${publicText(input.summary || input.reason, "No actionable defects were found.")}

## Next step
The reviewed head is approved. The configured handoff or merge safety checks can continue.

${reviewMarker({ ...input, outcome: "approved" })}`;
}

function renderHumanRequiredComment(input: JsonObject): string {
  return `## Review result: human decision required

- Reviewed commit: ${code(input.headOid)}
- Reason: ${publicText(input.reason, "The reviewer could not safely decide or repair this result.")}
- Context: ${publicText(input.summary, "Review the findings and choose the safe next action.")}

## Recovery steps
Resolve the decision above, push a new commit if code changes are needed, then remove ${code(input.blockedLabel || "agent:blocked")} so the new head can be reviewed.

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
The new head will be reviewed again. The review queue label remains in place while the active-review claim is released.

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
