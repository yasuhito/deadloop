const { createHash } = require("node:crypto");
const ROLE_CODES = { worker: "w", explorer: "e", reviewer: "r", "review-repair": "x", "branch-update": "u" };
const MAX_TARGET = 2147483647;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
function deriveHerdrAgentName(input) {
  if (!input.repository || !input.launchUuid) throw new Error("Herdr agent identity must be non-empty");
  if (!Number.isInteger(input.target) || input.target < 1 || input.target > MAX_TARGET) {
    throw new Error(`Herdr agent target must be an integer from 1 through ${MAX_TARGET}`);
  }
  const role = ROLE_CODES[input.role];
  if (!role) throw new Error(`Herdr agent role is invalid: ${String(input.role)}`);
  const hash = createHash("sha256").update([input.repository, input.role, String(input.target), input.launchUuid].join("\0")).digest("hex").slice(0, 12);
  const name = `dl-${role}-${input.target}-${hash}`;
  if (!AGENT_NAME.test(name)) throw new Error(`Herdr agent name is invalid: ${name}`);
  if (input.liveNames?.includes(name)) throw new Error(`Herdr agent name is already live: ${name}`);
  const recordedAttempt = input.recordedNames?.[name];
  if (recordedAttempt && recordedAttempt !== input.launchUuid) {
    throw new Error(`Herdr agent name collides with attempt ${recordedAttempt}: ${name}`);
  }
  return name;
}
module.exports = { deriveHerdrAgentName };
