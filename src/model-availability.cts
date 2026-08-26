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

module.exports = { isModelAvailabilityRejection };
