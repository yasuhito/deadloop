import { describe, expect, it } from "vitest";

import {
  findEnabledProject,
  isEnabledProjectState,
  normalizeEnablementState,
  removeEnabledProject,
  upsertEnabledProject,
} from "../src/enablement";

const project = { repoPath: "/repos/demo", githubRepo: "owner/demo" };

describe("local enablement state", () => {
  it("starts disabled when no state file exists", () => {
    expect(isEnabledProjectState(null, project)).toBe(false);
  });

  it("finds an enabled project only when checkout and GitHub identity match", () => {
    const state = upsertEnabledProject(null, project);

    expect(findEnabledProject(state, project)?.githubRepo).toBe("owner/demo");
  });

  it("rejects a record when the checkout path belongs to another repository", () => {
    const state = upsertEnabledProject(null, project);

    expect(isEnabledProjectState(state, { ...project, githubRepo: "other/demo" })).toBe(false);
  });

  it("removes the selected project without removing other enabled projects", () => {
    const state = upsertEnabledProject(upsertEnabledProject(null, project), { repoPath: "/repos/other", githubRepo: "owner/other" });

    expect(removeEnabledProject(state, project).projects).toHaveLength(1);
  });

  it("preserves the first-enable auto-merge gate metadata", () => {
    const state = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true, firstEnableConfigMtimeMs: 2 });

    expect(findEnabledProject(state, project)?.firstEnableAutoMerge).toBe(true);
  });

  it("rejects invalid first-enable auto-merge gate metadata", () => {
    expect(normalizeEnablementState({ projects: [{ ...project, enabledAt: 1, firstEnableAutoMerge: "true" }] })).toBeNull();
  });
});
