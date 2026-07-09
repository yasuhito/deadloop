import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { planIssueCoordinatorAction } = require("../extensions/deadloop/automations/issue-coordinator-flow.ts");

const fixtureDir = path.join(process.cwd(), "test/fixtures/issue-coordinator");

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
}

describe("Issue coordinator use-case flow", () => {
  it("plans no-candidate when the decision has no selected issue", () => {
    const data = fixture("driver-no-candidate.json");

    expect(planIssueCoordinatorAction(data.issues, { selected: false }).kind).toBe("skip_no_candidate");
  });

  it("plans contract-missing before Worker launch", () => {
    const data = fixture("driver-contract-missing.json");

    expect(planIssueCoordinatorAction(data.issues, { selected: true, number: 10 }).kind).toBe("contract_missing");
  });

  it("plans planning issues as blocked before Worker launch", () => {
    const data = fixture("driver-blocked-prd.json");

    expect(planIssueCoordinatorAction(data.issues, { selected: true, number: 11 }).kind).toBe("planning_blocked");
  });

  it("plans Worker launch for implementable issues", () => {
    const data = fixture("driver-ready-worker.json");

    expect(planIssueCoordinatorAction(data.issues, { selected: true, number: 12 }).kind).toBe("worker_required");
  });

  it("does not block implementable issues that only reference a PRD document path", () => {
    const data = fixture("driver-prd-doc-reference.json");

    expect(planIssueCoordinatorAction(data.issues, { selected: true, number: 70 }).kind).toBe("worker_required");
  });
});
