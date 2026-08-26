const MODEL_AVAILABILITY_REJECTIONS = [
  /credit balance is too low/i,
  /(?:usage|spending) limit (?:has been )?(?:reached|exceeded)/i,
  /(?:quota|rate limit) (?:has been )?exceeded/i,
  /(?:do not|don't) have access to (?:this |the )?model/i,
];

function isModelAvailabilityRejection(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const terminalLine = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || "";
  return MODEL_AVAILABILITY_REJECTIONS.some((pattern) => pattern.test(terminalLine));
}

const UNIT_MILLISECONDS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  s: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  h: 3_600_000,
};

/**
 * Provider-stated retry timing from terminal evidence, as an absolute ISO timestamp.
 * Only explicit provider wording counts — relative durations ("try again in 12h30m"),
 * HTTP-style `retry-after` seconds, and absolute timestamps. No timing means null, and
 * the normal next scheduler tick stays the only retry trigger.
 */
function parseProviderRetryAt(evidence: unknown, now: number): string | null {
  if (typeof evidence !== "string" || !Number.isFinite(now)) return null;
  for (const line of evidence.split(/\r?\n/)) {
    const relative = line.match(
      /try again (?:after|in) ((?:\d+\s*[a-z]+\s*)+)/i,
    );
    if (relative) {
      let milliseconds = 0;
      for (const part of relative[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
        const unit = UNIT_MILLISECONDS[part[2].toLowerCase()];
        if (!unit) continue;
        milliseconds += Number(part[1]) * unit;
      }
      if (milliseconds > 0) return new Date(now + milliseconds).toISOString();
    }
    const retryAfter = line.match(/retry-after:? (\d+)/i);
    if (retryAfter && Number(retryAfter[1]) > 0) return new Date(now + Number(retryAfter[1]) * 1_000).toISOString();
    const absolute = line.match(/(?:retry|try again) after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
    if (absolute) {
      const at = Date.parse(absolute[1]);
      if (Number.isFinite(at) && at > now) return new Date(at).toISOString();
    }
  }
  return null;
}

module.exports = { isModelAvailabilityRejection, parseProviderRetryAt };
