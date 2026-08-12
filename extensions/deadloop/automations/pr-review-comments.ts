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

function renderReviewItems(items: JsonObject[], emptyText: string): string {
  if (!items.length) return emptyText;
  return items.map((item: JsonObject) => {
    const path = publicRepoPath(item.path);
    const location = item.line && path !== "Not specified" ? `${path}:${item.line}` : path;
    const severity = item.severity ? ` — ${item.severity}` : "";
    return `### ${publicText(item.title, "Review observation")}${severity}\n- File: ${code(location)}\n- Reason: ${publicText(item.body, "The detailed evidence contained internal runtime information and was omitted.")}`;
  }).join("\n\n");
}

function priorDisposition(input: JsonObject): string {
  return publicText(input.priorFindingDisposition?.summary, "No prior required findings were reported.");
}

function renderChangesRequestedComment(input: JsonObject): string {
  const findings = renderReviewItems(input.findings || [], "No current required findings were reported.");
  const advisories = renderReviewItems(input.advisoryObservations || [], "None.");
  const marker = renderRepairMarker(input.headOid, input.reviewFingerprint);
  const nextStep = input.repairUnavailable
    ? input.repairUnavailableReason === "repair_progress_not_reported"
      ? "Automatic repair will not start because the review did not explicitly confirm repair progress. Inspect the history comparison and request a fresh review or resolve the findings manually."
      : input.repairUnavailableReason === "cumulative_repair_limit"
        ? "This PR reached the current cumulative automatic-repair limit. Inspect the current head and resolve the findings manually."
        : "Automatic repair will not start for this result. Inspect the current head and resolve the findings manually."
    : input.repairAlreadyStarted
      ? "Automatic repair already started for this review result and will not be launched twice."
      : "Automatic repair will address only the required findings above. The updated head will receive a fresh review after a successful push.";
  const nextHeading = input.repairUnavailable ? "Recovery steps" : "Next step";
  return `## Review result: changes required

- Reviewed commit: ${code(input.headOid)}
- Prior required findings: ${priorDisposition(input)}

## Current required findings
${findings}

## Advisory observations
${advisories}

## ${nextHeading}
${nextStep}

${reviewMarker({ ...input, outcome: "changes_requested" })}${input.repairUnavailable ? "" : `\n${marker}`}`;
}

function renderApprovedReviewComment(input: JsonObject): string {
  const advisories = renderReviewItems(input.advisoryObservations || [], "None.");
  return `## Review result: approved

- Reviewed commit: ${code(input.headOid)}
- Prior required findings: ${priorDisposition(input)}
- Reason: ${publicText(input.summary || input.reason, "No required defects were found.")}

## Current required findings
None.

## Advisory observations
${advisories}

## Next step
The reviewed head is approved. The configured handoff or merge safety checks can continue.

${reviewMarker({ ...input, outcome: "approved" })}`;
}

function renderHumanRequiredComment(input: JsonObject): string {
  const findings = renderReviewItems(input.findings || [], "None reported.");
  const advisories = renderReviewItems(input.advisoryObservations || [], "None.");
  return `## Review result: human decision required

- Reviewed commit: ${code(input.headOid)}
- Prior required findings: ${priorDisposition(input)}
- Context: ${publicText(input.summary, "Review the evidence and choose the safe next action.")}

## Current required findings
${findings}

## Advisory observations
${advisories}

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
