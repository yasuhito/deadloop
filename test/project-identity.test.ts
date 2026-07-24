import path from "node:path";
import { describe, expect, it } from "vitest";

import { inferredProjectId, schedulerLockName } from "../src/project-identity";

describe("canonical project identity", () => {
  const first = { id: "app", repoPath: path.join("/a", "app"), githubRepo: "owner/first", githubRepositoryId: "R_first" };
  const second = { id: "app", repoPath: path.join("/b", "app"), githubRepo: "owner/second", githubRepositoryId: "R_second" };

  it("uses different scheduler locks for repositories with the same basename", () => {
    expect(schedulerLockName(first)).not.toBe(schedulerLockName(second));
  });

  it("uses the same scheduler lock when only the explicit project id changes", () => {
    const renamed = { ...first, id: "renamed" };
    expect(schedulerLockName(first)).toBe(schedulerLockName(renamed));
  });

  it("uses the same scheduler lock for distinct checkouts of one GitHub repository", () => {
    const otherCheckout = { ...first, repoPath: "/another/first" };
    expect(schedulerLockName(first)).toBe(schedulerLockName(otherCheckout));
  });

  it("uses the same scheduler lock after a GitHub repository rename", () => {
    const renamed = { ...first, githubRepo: "owner/renamed" };
    expect(schedulerLockName(first)).toBe(schedulerLockName(renamed));
  });

  it("fails closed when the immutable GitHub repository ID is missing", () => {
    expect(() => schedulerLockName({ ...first, githubRepositoryId: undefined })).toThrow(/immutable GitHub repository ID/);
  });

  it("uses different inferred worktree directory ids for repositories with the same basename", () => {
    expect(inferredProjectId(first.repoPath, first.githubRepo)).not.toBe(inferredProjectId(second.repoPath, second.githubRepo));
  });
});
