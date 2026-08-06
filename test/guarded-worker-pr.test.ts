import { describe, expect, it } from "vitest";

const { assertWorkerPrBinding } = require("../extensions/deadloop/automations/guarded-worker-pr.ts");

describe("guarded Worker PR binding", () => {
  it("rejects another GitHub repository before PR creation", () => {
    expect(() => assertWorkerPrBinding(
      { project: "demo", repository: "owner/repo" },
      { projectId: "demo", githubRepo: "other/repo" },
    )).toThrow("repository");
  });

  it("rejects another configured project before PR creation", () => {
    expect(() => assertWorkerPrBinding(
      { project: "demo", repository: "owner/repo" },
      { projectId: "other", githubRepo: "owner/repo" },
    )).toThrow("project");
  });
});
