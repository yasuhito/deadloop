import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sanitizeId } from "./core";

function canonicalRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function projectIdentityHash(repoPath: string, githubRepo: string): string {
  const identity = `${canonicalRepoPath(repoPath)}\0${githubRepo.toLowerCase()}`;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

export function inferredProjectId(repoPath: string, githubRepo: string): string {
  return `${sanitizeId(path.basename(repoPath))}-${projectIdentityHash(repoPath, githubRepo)}`;
}

export function schedulerLockName(project: { githubRepositoryId?: string }): string {
  if (!project.githubRepositoryId) throw new Error("immutable GitHub repository ID is required for scheduler ownership");
  const repositoryHash = crypto.createHash("sha256").update(project.githubRepositoryId).digest("hex").slice(0, 12);
  return `scheduler.${repositoryHash}.lock`;
}
