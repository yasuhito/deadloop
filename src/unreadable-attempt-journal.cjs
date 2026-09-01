// 読めない終端記録（unreadable terminal attempt record）の host-log 報告。
//
// 契約から削除した理由コードなどを持つ旧 journal は、現在の契約では検証を通らない。終端
// phase で終わった試行の記録は証拠であって生きた状態ではないため、host の巡回と reconciler
// はこれを 1 回だけ host-log に記録してスキップする。このモジュールは state 配下の marker
// ファイルで「報告済み」を保持し、tick ごとの重複報告を防ぐ。報告は観測であり、失敗が
// 呼び出し元の判定を変えてはいけない。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// @ts-expect-error Node loads this CommonJS-style TypeScript module with built-in type stripping.
const { appendHostLogEvent } = require("./host-log.cts");
const { formatUnreadableAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");

function unreadableAttemptRecordMarkerPath(stateDir, recordPath) {
  const digest = crypto.createHash("sha256").update(path.resolve(recordPath)).digest("hex").slice(0, 24);
  return path.join(stateDir, "unreadable-attempt-records", `${digest}.json`);
}

/**
 * Reports one unreadable terminal attempt record to the host activity log, at most once per
 * record path. Returns true when the event was appended now; an already-reported record stays
 * silent so ticks do not repeat it. Observational only: a failed report never changes the
 * caller's outcome.
 */
function reportUnreadableAttemptRecordOnce(stateDir, record, now = new Date()) {
  const marker = unreadableAttemptRecordMarkerPath(stateDir, record.recordPath);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ recordPath: record.recordPath, phase: record.phase, field: record.field ?? "", reportedAt: now.toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch {
    return false;
  }
  return appendHostLogEvent(stateDir, {
    kind: "unreadable_attempt_record",
    reason: formatUnreadableAttemptRecord(record),
    attemptId: record.attemptId ?? "",
  }, now);
}

/** The archive directory doctor names when an unreadable journal needs manual review. */
function manualReviewArchiveDir(stateDir) {
  return path.join(stateDir, "manual-review-archive");
}

module.exports = { manualReviewArchiveDir, reportUnreadableAttemptRecordOnce, unreadableAttemptRecordMarkerPath };
