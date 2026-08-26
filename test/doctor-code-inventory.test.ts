import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDoctorSnapshot, formatDoctorReport, type DoctorFinding } from "../src/doctor";
import { normalizeProject } from "../src/core";
import type { CodeSnapshotInventory } from "../src/code-snapshot-inventory";

function inventory(generations: Array<{ codeIdentity: string; bytes: number }>): CodeSnapshotInventory {
  return { root: "/state/deadloop/code-snapshots", generations };
}

function doctorFindings(codeSnapshots: CodeSnapshotInventory | null, extra: Record<string, unknown> = {}): DoctorFinding[] {
  const project = normalizeProject({ id: "demo", repoPath: "/repos/demo", githubRepo: "owner/demo" });
  return buildDoctorSnapshot({
    cwd: "/repos/demo",
    projects: [project],
    selectedProject: project,
    codeSnapshots,
    ...extra,
  }).findings;
}

describe("doctor code snapshot inventory findings", () => {
  it("reports the generation count and capacity of the injected inventory", () => {
    const [finding] = doctorFindings(inventory([
      { codeIdentity: "a".repeat(40), bytes: 2048 },
      { codeIdentity: "b".repeat(40), bytes: 1024 },
    ]));

    expect(finding?.title).toBe("code snapshot inventory: 2 generation(s), 3 KB");
  });

  it("presents a cleanup command for a generation no trace refers to", () => {
    const stale = "c".repeat(40);
    const [finding] = doctorFindings(
      inventory([{ codeIdentity: "a".repeat(40), bytes: 10 }, { codeIdentity: stale, bytes: 10 }]),
      { deployedCodeIdentity: "a".repeat(40), loadedCodeIdentity: "a".repeat(40), lastWriterCodeIdentity: "a".repeat(40) },
    );

    expect(finding?.commands).toEqual([
      "du -sh /state/deadloop/code-snapshots/*",
      `rm -rf ${path.join("/state/deadloop/code-snapshots", stale)}`,
    ]);
  });

  it("suggests no removal when every generation is named by a trace this session can see", () => {
    const identity = "a".repeat(40);
    const [finding] = doctorFindings(inventory([{ codeIdentity: identity, bytes: 10 }]), {
      deployedCodeIdentity: identity,
      lastWriterCodeIdentity: identity,
    });

    expect(finding?.commands).toEqual(["du -sh /state/deadloop/code-snapshots/*"]);
  });

  it("never asserts which code another session loaded or is running", () => {
    const [finding] = doctorFindings(inventory([
      { codeIdentity: "b".repeat(40), bytes: 10 },
      { codeIdentity: "c".repeat(40), bytes: 10 },
    ]), { lastWriterCodeIdentity: "a".repeat(40) });
    const wording = `${finding?.summary} ${finding?.title}`;

    expect(/may still be running|cannot be known/.test(wording)).toBe(true);
  });

  it("reports nothing when there are no snapshots to report", () => {
    expect(doctorFindings(null)).toHaveLength(0);
  });
});

describe("doctor enablement writer reporting", () => {
  it("reports the code identity that last wrote the shared enablement state", () => {
    const project = normalizeProject({ id: "demo", repoPath: "/repos/demo", githubRepo: "owner/demo" });
    const snapshot = buildDoctorSnapshot({
      cwd: "/repos/demo",
      projects: [project],
      selectedProject: project,
      lastWriterCodeIdentity: "a".repeat(40),
    });
    const report = formatDoctorReport(snapshot);

    expect(report).toContain(`last enablement write by code identity: ${"a".repeat(40)}`);
  });
});
