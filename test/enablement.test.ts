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
import { preserveEnablementAutomationLogins } from "../src/enablement-write";

const project = { repoPath: "/repos/demo", githubRepo: "owner/demo", githubRepositoryId: "R_demo" };
const safetyFields = {
  firstEnableAutoMerge: false,
  firstStartPending: false,
  lastObservedAutoMerge: false,
  autoMergeAcknowledged: false,
  enabled: true,
};
const writerCodeIdentity = "a".repeat(40);

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

  it("does not acknowledge an unchanged pre-existing true setting after the safe first start", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const afterSafeStart = { projects: initial.projects.map((enabled) => ({ ...enabled, firstStartPending: false })) };

    expect(findEnabledProject(observeAutoMerge(afterSafeStart, project, true), project)?.autoMergeAcknowledged).toBe(false);
  });

  it("acknowledges a post-enable change from false to true", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const afterSafeStart = { projects: initial.projects.map((enabled) => ({ ...enabled, firstStartPending: false })) };
    const observedFalse = observeAutoMerge(afterSafeStart, project, false);

    expect(findEnabledProject(observeAutoMerge(observedFalse, project, true), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("retains an auto-merge acknowledgement when re-enabled", () => {
    const initial = upsertEnabledProject(null, project, 1, { firstEnableAutoMerge: true });
    const afterSafeStart = { projects: initial.projects.map((enabled) => ({ ...enabled, firstStartPending: false })) };
    const observedFalse = observeAutoMerge(afterSafeStart, project, false);
    const acknowledged = observeAutoMerge(observedFalse, project, true);

    expect(findEnabledProject(upsertEnabledProject(removeEnabledProject(acknowledged, project), project, 2), project)?.autoMergeAcknowledged).toBe(true);
  });

  it("does not let a stale state normalizer erase the authorized automation login", () => {
    const previous = upsertEnabledProject(null, { ...project, automationLogin: "Deadloop-Bot" });
    const staleUpdate = { projects: previous.projects.map(({ automationLogin: _automationLogin, ...enabled }) => enabled) };

    expect(preserveEnablementAutomationLogins(previous, staleUpdate).projects[0].automationLogin).toBe("deadloop-bot");
  });

  it("does not transfer authorization to a different immutable GitHub repository", () => {
    const previous = upsertEnabledProject(null, { ...project, automationLogin: "deadloop-bot" });
    const replacement = upsertEnabledProject(null, { ...project, githubRepositoryId: "R_replacement" });

    expect(preserveEnablementAutomationLogins(previous, replacement).projects[0].automationLogin).toBeUndefined();
  });

  it("rejects invalid first-enable auto-merge gate metadata", () => {
    expect(normalizeEnablementState({ projects: [{ ...project, enabledAt: 1, firstEnableAutoMerge: "true" }], lastWriterCodeIdentity: writerCodeIdentity })).toBeNull();
  });

  it("requires the code identity of the Automation host that wrote the shared state", () => {
    expect(normalizeEnablementState({ projects: [], lastWriterCodeIdentity: undefined })).toBeNull();
  });

  it("rejects a recorded writer identity that is not a full commit SHA", () => {
    expect(normalizeEnablementState({ projects: [], lastWriterCodeIdentity: "not-a-commit" })).toBeNull();
  });

  it("keeps the recorded writer identity in the normalized shared state", () => {
    expect(normalizeEnablementState({ projects: [], lastWriterCodeIdentity: writerCodeIdentity.toUpperCase() })).toEqual({ projects: [], lastWriterCodeIdentity: writerCodeIdentity });
  });

  it("rejects duplicate canonical checkout paths", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/other/../demo", githubRepo: "owner/other", ...safetyFields, enabledAt: 2 },
    ], lastWriterCodeIdentity: writerCodeIdentity })).toBeNull();
  });

  it("rejects duplicate GitHub repositories", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/other", githubRepo: "OWNER/DEMO", githubRepositoryId: "R_other", ...safetyFields, enabledAt: 2 },
    ], lastWriterCodeIdentity: writerCodeIdentity })).toBeNull();
  });

  it("rejects duplicate immutable GitHub repository IDs across renamed aliases", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { repoPath: "/repos/renamed", githubRepo: "owner/renamed", ...safetyFields, enabledAt: 2 },
    ], lastWriterCodeIdentity: writerCodeIdentity })).toBeNull();
  });

  it("rejects duplicate exact identities", () => {
    expect(normalizeEnablementState({ projects: [
      { ...project, ...safetyFields, enabledAt: 1 },
      { ...project, ...safetyFields, enabledAt: 2 },
    ], lastWriterCodeIdentity: writerCodeIdentity })).toBeNull();
  });
});
