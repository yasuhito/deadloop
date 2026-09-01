import { describe, expect, it } from "vitest";

import { buildDoctorSnapshot, type DoctorFinding } from "../src/doctor";
import { normalizeProject } from "../src/core";

function project() {
  return normalizeProject({ id: "demo", repoPath: "/repos/demo", githubRepo: "owner/demo", workerModel: "test-model", reviewerModel: "review-model" });
}

function findings(openPrs: unknown[], extra: Record<string, unknown> = {}): DoctorFinding[] {
  const selected = project();
  return buildDoctorSnapshot({
    cwd: "/repos/demo",
    projects: [selected],
    selectedProject: selected,
    openPrs: openPrs as never,
    ...extra,
  }).findings;
}

const changesRequestedMarker = "<!-- deadloop:review-result head=" + "a".repeat(40) + " review=" + "b".repeat(20) + " outcome=changes_requested -->";
const approvedMarker = "<!-- deadloop:review-result head=" + "a".repeat(40) + " review=" + "b".repeat(20) + " outcome=approved -->";
const repairResultMarker = "<!-- deadloop:review-repair-result key=" + "c".repeat(20) + " head=" + "d".repeat(40) + " -->";

function pr(labels: string[], comments: string[], number = 243): unknown {
  return { number, title: "Fix the loop", labels: labels.map((name) => ({ name })), comments: comments.map((body) => ({ body })) };
}

describe("doctor review-result-without-repair-request findings", () => {
  it("suggests the repair request label for a PR whose review result never queued one", () => {
    const result = findings([
      pr(["agent:in-progress", "agent:review"], [`${"## Review result: changes required"} ${changesRequestedMarker}`]),
    ]);

    expect(result.find((finding) => finding.type === "review_repair_missing")?.commands).toEqual([
      "gh pr edit 243 -R owner/demo --add-label agent:implement",
    ]);
  });

  it("stays silent while the reviewer result is still being dispatched", () => {
    const result = findings(
      [pr(["agent:in-progress"], [changesRequestedMarker])],
      { retainedTargets: [{ kind: "pull-request", number: 243 }] },
    );

    expect(result.find((finding) => finding.type === "review_repair_missing")).toBeUndefined();
  });

  it("stays silent when the repair request already replaced the claim", () => {
    const result = findings([pr(["agent:implement", "agent:review"], [changesRequestedMarker])]);

    expect(result.find((finding) => finding.type === "review_repair_missing")).toBeUndefined();
  });

  it("stays silent when the automatic repair already completed a round", () => {
    const result = findings([pr(["agent:in-progress"], [changesRequestedMarker, repairResultMarker])]);

    expect(result.find((finding) => finding.type === "review_repair_missing")).toBeUndefined();
  });

  it("stays silent when the posted review result is not a repair request", () => {
    const result = findings([pr(["agent:in-progress"], [approvedMarker])]);

    expect(result.find((finding) => finding.type === "review_repair_missing")).toBeUndefined();
  });
});
