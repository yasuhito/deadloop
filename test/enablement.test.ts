import { describe, expect, it } from "vitest";

import {
  findEnabledProject,
  isEnabledProjectState,
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
});
