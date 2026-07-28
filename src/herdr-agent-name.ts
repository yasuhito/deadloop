import { createHash } from "node:crypto";

import type { AttemptRole } from "./attempt-lifecycle";

const ROLE_CODES: Record<AttemptRole, string> = {
  worker: "w",
  reviewer: "r",
  "review-repair": "x",
  "branch-update": "u",
};
const MAX_TARGET = 2_147_483_647;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export type Herdr075AgentNameInput = {
  repository: string;
  role: AttemptRole;
  target: number;
  launchUuid: string;
  liveNames?: string[];
  recordedNames?: Record<string, string>;
};

function requiredText(value: string, field: string): string {
  if (!value) throw new Error(`Herdr agent ${field} must be non-empty`);
  return value;
}

export function deriveHerdr075AgentName(input: Herdr075AgentNameInput): string {
  requiredText(input.repository, "repository");
  requiredText(input.launchUuid, "launch UUID");
  if (!Number.isInteger(input.target) || input.target < 1 || input.target > MAX_TARGET) {
    throw new Error(`Herdr agent target must be an integer from 1 through ${MAX_TARGET}`);
  }
  const role = ROLE_CODES[input.role];
  if (!role) throw new Error(`Herdr agent role is invalid: ${String(input.role)}`);
  const hash = createHash("sha256")
    .update([input.repository, input.role, String(input.target), input.launchUuid].join("\0"))
    .digest("hex")
    .slice(0, 12);
  const name = `dl-${role}-${input.target}-${hash}`;
  if (!AGENT_NAME.test(name)) throw new Error(`Herdr agent name is invalid: ${name}`);
  if (input.liveNames?.includes(name)) throw new Error(`Herdr agent name is already live: ${name}`);
  const recordedAttempt = input.recordedNames?.[name];
  if (recordedAttempt && recordedAttempt !== input.launchUuid) {
    throw new Error(`Herdr agent name collides with attempt ${recordedAttempt}: ${name}`);
  }
  return name;
}
