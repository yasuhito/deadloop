import { describe, expect, it } from "vitest";

import {
  findEnabledProject,
  isEnabledProjectState,
  normalizeEnablementState,
  observeAutoMerge,
  removeEnabledProject,
  removeEnabledProjectGeneration,
  upsertEnabledProject,
} from "../src/enablement";

const project = { repoPath: "/repos/demo", githubRepo: "owner/demo", githubRepositoryId: "R_demo" };
const safetyFields = {
  firstEnableAutoMerge: false,
  firstStartPending: false,
  lastObservedAutoMerge: false,
  autoMergeAcknowledged: false,
  enabled: true,
};

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

  it("disables the selected project without removing its safety history", () => {
    const state = upsertEnabledProject(upsertEnabledProject(null, project), { repoPath: "/repos/other", githubRepo: "owner/other", githubRepositoryId: "R_other" });

    expect(isEnabledProjectState(removeEnabledProject(state, project), project)).toBe(false);
  });

  it("preserves the first-enable auto-merge gate metadata", () => {
    const state = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });

    expect(findEnabledProject(state, project)?.firstEnableAutoMerge).toBe(true);
  });

  it("persists a pending first scheduler start independently of auto-merge configuration", () => {
    const state = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: false });

    expect(findEnabledProject(state, project)?.firstStartPending).toBe(true);
  });

  it("preserves the generation on repeated enable", () => {
    const initial = upsertEnabledProject(null, project, 10);

    expect(findEnabledProject(upsertEnabledProject(initial, project, 20), project)?.enabledAt).toBe(10);
  });

  it("gives a disabled-to-enabled transition a newer generation", () => {
    const first = upsertEnabledProject(null, project, 10);
    const second = upsertEnabledProject(removeEnabledProject(first, project), project, 10);

    expect(findEnabledProject(second, project)?.enabledAt).toBe(11);
  });

  it("does not let failed cleanup from an earlier enable disable a later enable", () => {
    const first = upsertEnabledProject(null, project, 10);
    const second = upsertEnabledProject(removeEnabledProject(first, project), project, 10);

    expect(isEnabledProjectState(removeEnabledProjectGeneration(second, project, 10), project)).toBe(true);
  });

  it("acknowledges an explicit true setting observed after the safe first start", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const afterSafeStart = { projects: initial.projects.map((enabled) => ({ ...enabled, firstStartPending: false })) };

    expect(findEnabledProject(observeAutoMerge(afterSafeStart, project, true), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("retains an auto-merge acknowledgement when re-enabled", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const afterSafeStart = { projects: initial.projects.map((enabled) => ({ ...enabled, firstStartPending: false })) };
    const acknowledged = observeAutoMerge(afterSafeStart, project, true);

    expect(findEnabledProject(upsertEnabledProject(removeEnabledProject(acknowledged, project), project, 2), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("rejects invalid first-enable auto-merge gate metadata", () => {
    expect(normalizeEnablementState({ projects: [{ ...project, enabledAt: 1, firstEnableAutoMerge: "true" }] })).toBeNull();
  });

  it("rejects duplicate canonical checkout paths", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/other/../demo", githubRepo: "owner/other", ...safetyFields, enabledAt: 2 },
    ] })).toBeNull();
  });

  it("rejects duplicate GitHub repositories", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/other", githubRepo: "OWNER/DEMO", githubRepositoryId: "R_other", ...safetyFields, enabledAt: 2 },
    ] })).toBeNull();
  });

  it("rejects duplicate immutable GitHub repository IDs across renamed aliases", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/renamed", githubRepo: "owner/renamed", ...safetyFields, enabledAt: 2 },
    ] })).toBeNull();
  });

  it("migrates a renamed repository record by immutable GitHub ID", () => {
    const initial = upsertEnabledProject(null, { ...project, githubAliases: ["owner/old"] }, 10);
    const renamed = upsertEnabledProject(initial, {
      repoPath: "/repos/renamed",
      githubRepo: "owner/renamed",
      githubRepositoryId: project.githubRepositoryId,
      githubAliases: ["owner/renamed"],
    }, 20);

    expect(renamed.projects).toEqual([expect.objectContaining({
      repoPath: "/repos/renamed",
      githubRepo: "owner/renamed",
      githubRepositoryId: "R_demo",
      enabledAt: 10,
      githubAliases: ["owner/old", "owner/demo", "owner/renamed"],
    })]);
  });

  it("rejects duplicate exact identities", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { ...project, ...safetyFields, enabledAt: 2 },
    ] })).toBeNull();
  });
});
