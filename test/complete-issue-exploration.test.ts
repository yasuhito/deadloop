import { describe, expect, it } from "vitest";

const {
  hasExplorationPersistenceProof,
  trustedExplorationResultComment,
} = require("../extensions/deadloop/automations/complete-issue-exploration.ts");

const claim = {
  binding: { requestEventId: "event-2" },
  requestLabel: "agent:explore",
  authorizedLogins: ["deadloop-bot"],
};
const body = "exploration result\n\n<!-- deadloop:issue-exploration-result request=event-2 -->";
const event = { id: "event-2", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } };

function resultComment(login: string) {
  return {
    id: "comment-1",
    author: { login },
    body,
    createdAt: "2026-08-16T00:01:00Z",
    updatedAt: "2026-08-16T00:01:00Z",
  };
}

describe("Issue exploration completion", () => {
  it("does not trust a copied result marker from another commenter", () => {
    expect(trustedExplorationResultComment([resultComment("other-user")], claim, body)).toBeNull();
  });

  it("trusts the exact unedited result from an authorized Automation host", () => {
    expect(trustedExplorationResultComment([resultComment("deadloop-bot")], claim, body)?.id).toBe("comment-1");
  });

  it("recognizes GitHub persistence after the success label mutation", () => {
    expect(hasExplorationPersistenceProof(
      { labels: new Set(["ready-for-agent"]), events: [event], comments: [resultComment("deadloop-bot")] },
      claim,
      body,
      false,
      { inProgress: "agent:in-progress", blocked: "agent:blocked" },
    )).toBe(true);
  });

  it("does not accept a result while the exploration claim is still active", () => {
    expect(hasExplorationPersistenceProof(
      { labels: new Set(["agent:in-progress"]), events: [event], comments: [resultComment("deadloop-bot")] },
      claim,
      body,
      false,
      { inProgress: "agent:in-progress", blocked: "agent:blocked" },
    )).toBe(false);
  });
});
