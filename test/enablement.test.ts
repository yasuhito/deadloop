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

  it("disables the selected project without removing its safety history", () => {
    const state = upsertEnabledProject(upsertEnabledProject(null, project), { repoPath: "/repos/other", githubRepo: "owner/other" });

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

  it("acknowledges auto-merge only after the setting changes from false to true", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const disabled = observeAutoMerge(initial, project, false);

    expect(findEnabledProject(observeAutoMerge(disabled, project, true), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("retains an auto-merge acknowledgement when re-enabled", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const acknowledged = observeAutoMerge(observeAutoMerge(initial, project, false), project, true);

    expect(findEnabledProject(upsertEnabledProject(removeEnabledProject(acknowledged, project), project, 2), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("rejects invalid first-enable auto-merge gate metadata", () => {
    expect(normalizeEnablementState({ projects: [{ ...project, enabledAt: 1, firstEnableAutoMerge: "true" }] })).toBeNull();
  });

  it("rejects duplicate canonical checkout paths", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, enabledAt: 1 },
      { repoPath: "/repos/other/../demo", githubRepo: "owner/other", enabledAt: 2 },
    ] })).toBeNull();
  });

  it("rejects duplicate GitHub repositories", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, enabledAt: 1 },
      { repoPath: "/repos/other", githubRepo: "OWNER/DEMO", enabledAt: 2 },
    ] })).toBeNull();
  });

  it("rejects duplicate exact identities", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, enabledAt: 1 },
      { ...project, enabledAt: 2 },
    ] })).toBeNull();
  });
});
