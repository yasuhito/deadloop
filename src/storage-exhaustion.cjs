/**
 * The deterministic storage-exhaustion contract (ADR 0018).
 *
 * Deadloop never predicts free space and adds no TMPDIR management. A storage-exhaustion stop exists
 * only where `ENOSPC` or `EDQUOT` was actually observed: by deadloop's own deterministic host
 * operations, or inside a completion report an agent wrote. Terminal text alone names a suspicion,
 * never a cause, so nothing here reads runtime output.
 */

const STORAGE_EXHAUSTION_CODES = new Set(["ENOSPC", "EDQUOT"]);
const STORAGE_EXHAUSTION_TEXT_RE = /(?:^|[^A-Za-z])(?:ENOSPC|EDQUOT)(?![A-Za-z])/;

function containsStorageExhaustion(text) {
  return STORAGE_EXHAUSTION_TEXT_RE.test(String(text || ""));
}

function isStorageExhaustionError(error) {
  return Boolean(error)
    && (STORAGE_EXHAUSTION_CODES.has(String(error.code || "").toUpperCase())
      || containsStorageExhaustion(error.message));
}

/** Whether a completion report's own result fields name an observed ENOSPC/EDQUOT failure. */
function reportNamesStorageExhaustion(report) {
  const fields = [
    ...(report && typeof report === "object" && typeof report.result === "object" && report.result
      ? [report.result.reason, report.result.explanation, report.result.recovery, report.result.informationRequest]
      : []),
    ...(!Array.isArray(report) && report && typeof report === "object"
      ? [report.reason, report.explanation, report.recovery, report.informationRequest]
      : []),
  ];
  return fields.some((text) => typeof text === "string" && containsStorageExhaustion(text));
}

module.exports = { containsStorageExhaustion, isStorageExhaustionError, reportNamesStorageExhaustion };
