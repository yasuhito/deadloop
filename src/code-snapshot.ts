import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_FILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const CODE_SNAPSHOT_DIRECTORY = "code-snapshots";
const DEPENDENCY_SNAPSHOT_DIRECTORY = "dependency-snapshots";

export type CodeSnapshot = {
  codeIdentity: string;
  lockHash: string;
  packageRoot: string;
  automationDir: string;
  dependencyRoot: string;
  created: boolean;
};

export type EnsureCodeSnapshotInput = {
  packageRoot: string;
  stateDir: string;
  codeIdentity?: string;
};

function git(packageRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", packageRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function committedLock(packageRoot: string, codeIdentity: string): { name: string; contents: Buffer } {
  for (const name of LOCK_FILES) {
    try {
      return { name, contents: execFileSync("git", ["-C", packageRoot, "show", `${codeIdentity}:${name}`], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }) };
    } catch {}
  }
  throw new Error(`code snapshot blocked: commit ${codeIdentity} has no supported lock file`);
}

function lockPackages(contents: Buffer): Record<string, Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(contents.toString("utf8"));
    return parsed?.packages && typeof parsed.packages === "object" ? parsed.packages : null;
  } catch {
    return null;
  }
}

function assertInstalledDependenciesMatchLock(packageRoot: string, lockContents: Buffer): void {
  const expected = lockPackages(lockContents);
  if (!expected) return;
  const installedLock = path.join(packageRoot, "node_modules", ".package-lock.json");
  let actual: Record<string, Record<string, unknown>> | null = null;
  try { actual = lockPackages(fs.readFileSync(installedLock)); } catch {}
  if (!actual) throw new Error("code snapshot blocked: installed dependencies have no npm lock evidence");
  const fields = ["version", "resolved", "integrity", "link"];
  for (const [name, entry] of Object.entries(expected)) {
    if (!name) continue;
    const installed = actual[name];
    if (!installed && entry.optional === true) continue;
    if (!installed || fields.some((field) => JSON.stringify(installed[field]) !== JSON.stringify(entry[field]))) {
      throw new Error(`code snapshot blocked: installed dependency does not match committed lock: ${name}`);
    }
    if (name.startsWith("node_modules/") && entry.version && entry.link !== true) {
      let installedVersion = "";
      try { installedVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, name, "package.json"), "utf8")).version || ""; } catch {}
      if (installedVersion !== entry.version) {
        throw new Error(`code snapshot blocked: installed package version does not match committed lock: ${name}`);
      }
    }
  }
  for (const name of Object.keys(actual)) {
    if (!expected[name]) throw new Error(`code snapshot blocked: installed dependency is absent from committed lock: ${name}`);
  }
}

function linkTree(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { mode: sourceStat.mode & 0o777 });
    for (const entry of fs.readdirSync(source)) linkTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (sourceStat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`unsupported dependency entry: ${source}`);
  fs.linkSync(source, destination);
}

function removeWritePermissions(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) removeWritePermissions(path.join(root, entry));
  }
  fs.chmodSync(root, stat.mode & ~0o222);
}

/**
 * Hard-linked files share their inode with the package checkout, so making one read-only would
 * strip write permission from the checkout as well. Only the snapshot's own directories become
 * read-only here; that still refuses every attempt to add, remove, or replace an entry inside
 * the snapshot. Trees which own their files use removeWritePermissions instead.
 */
function removeSharedTreeWritePermissions(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root)) removeSharedTreeWritePermissions(path.join(root, entry));
  fs.chmodSync(root, stat.mode & ~0o222);
}

/** A read-only directory cannot drop its own entries, so write access returns before removal. */
function removeSnapshotTree(root: string): void {
  restoreDirectoryWritePermissions(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function restoreDirectoryWritePermissions(root: string): void {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  fs.chmodSync(root, stat.mode | 0o200);
  for (const entry of fs.readdirSync(root)) restoreDirectoryWritePermissions(path.join(root, entry));
}

/** Publishes the staged tree, or discards it when another host published the same one first. */
function publishSnapshot(temporary: string, destination: string): { created: boolean } {
  try {
    fs.renameSync(temporary, destination);
    return { created: true };
  } catch (error) {
    if (!fs.existsSync(destination)) throw error;
    removeSnapshotTree(temporary);
    return { created: false };
  }
}

function ensureDependencySnapshot(packageRoot: string, stateDir: string, lockHash: string, lockContents: Buffer): string {
  const destination = path.join(stateDir, DEPENDENCY_SNAPSHOT_DIRECTORY, lockHash, "node_modules");
  if (fs.lstatSync(path.dirname(destination), { throwIfNoEntry: false })?.isDirectory() && fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    return destination;
  }

  assertInstalledDependenciesMatchLock(packageRoot, lockContents);
  const source = path.join(packageRoot, "node_modules");
  if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`code snapshot blocked: local dependencies are unavailable at ${source}`);
  }
  const parent = path.join(stateDir, DEPENDENCY_SNAPSHOT_DIRECTORY);
  fs.mkdirSync(parent, { recursive: true });
  const stagedSnapshot = path.join(parent, `.${lockHash}.${process.pid}.${randomUUID()}.tmp`);
  const stagedDependencies = path.join(stagedSnapshot, "node_modules");
  try {
    fs.mkdirSync(stagedSnapshot);
    linkTree(source, stagedDependencies);
    removeSharedTreeWritePermissions(stagedDependencies);
    publishSnapshot(stagedSnapshot, path.dirname(destination));
  } catch (error) {
    removeSnapshotTree(stagedSnapshot);
    // A hard link cannot cross a filesystem boundary. Name both sides, because the raw EXDEV
    // says nothing about which two directories an operator has to bring back together.
    if ((error as NodeJS.ErrnoException)?.code === "EXDEV") {
      throw new Error(`code snapshot blocked: state directory ${stateDir} and package checkout ${packageRoot} are on different filesystems, so dependencies cannot be hard-linked`);
    }
    throw error;
  }
  if (!fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`code snapshot blocked: dependency snapshot was not published at ${destination}`);
  }
  return destination;
}

function ensurePackageSnapshot(
  packageRoot: string,
  stateDir: string,
  codeIdentity: string,
  lock: { name: string; contents: Buffer },
  dependencyRoot: string,
): { packageRoot: string; created: boolean } {
  const snapshotsRoot = path.join(stateDir, CODE_SNAPSHOT_DIRECTORY);
  const destination = path.join(snapshotsRoot, codeIdentity, "package");
  const existingLock = path.join(destination, lock.name);
  if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    if (!fs.existsSync(existingLock) || !fs.readFileSync(existingLock).equals(lock.contents)) {
      throw new Error(`code snapshot blocked: existing snapshot ${destination} does not match ${codeIdentity}`);
    }
    const dependencyLink = path.join(destination, "node_modules");
    if (!fs.lstatSync(dependencyLink, { throwIfNoEntry: false })?.isSymbolicLink()
      || path.resolve(destination, fs.readlinkSync(dependencyLink)) !== path.resolve(dependencyRoot)) {
      throw new Error(`code snapshot blocked: existing snapshot ${destination} has invalid dependencies`);
    }
    return { packageRoot: destination, created: false };
  }

  fs.mkdirSync(snapshotsRoot, { recursive: true });
  const stagedSnapshot = path.join(snapshotsRoot, `.${codeIdentity}.${process.pid}.${randomUUID()}.tmp`);
  const temporaryPackage = path.join(stagedSnapshot, "package");
  const archive = path.join(stagedSnapshot, "package.tar");
  try {
    fs.mkdirSync(temporaryPackage, { recursive: true });
    execFileSync("git", ["-C", packageRoot, "archive", "--format=tar", `--output=${archive}`, codeIdentity], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    execFileSync("tar", ["-xf", archive, "-C", temporaryPackage], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    fs.rmSync(archive);
    if (!fs.readFileSync(path.join(temporaryPackage, lock.name)).equals(lock.contents)) {
      throw new Error("extracted snapshot lock does not match the selected commit");
    }
    fs.symlinkSync(path.relative(temporaryPackage, dependencyRoot), path.join(temporaryPackage, "node_modules"));
    removeWritePermissions(temporaryPackage);
    const { created } = publishSnapshot(stagedSnapshot, path.dirname(destination));
    return { packageRoot: destination, created };
  } catch (error) {
    removeSnapshotTree(stagedSnapshot);
    throw error;
  }
}

export function ensureCodeSnapshot(input: EnsureCodeSnapshotInput): CodeSnapshot {
  const packageRoot = fs.realpathSync(input.packageRoot);
  const repositoryRoot = fs.realpathSync(git(packageRoot, ["rev-parse", "--show-toplevel"]));
  if (repositoryRoot !== packageRoot) {
    throw new Error(`code snapshot blocked: package root must be the Git repository root: ${packageRoot}`);
  }
  const codeIdentity = input.codeIdentity || git(packageRoot, ["rev-parse", "HEAD^{commit}"]);
  if (!/^[0-9a-f]{40}$/i.test(codeIdentity)) throw new Error("code snapshot blocked: code identity is not a full commit SHA");
  const lock = committedLock(packageRoot, codeIdentity);
  const lockHash = createHash("sha256").update(lock.contents).digest("hex");
  fs.mkdirSync(input.stateDir, { recursive: true });
  const dependencyRoot = ensureDependencySnapshot(packageRoot, input.stateDir, lockHash, lock.contents);
  const snapshot = ensurePackageSnapshot(packageRoot, input.stateDir, codeIdentity, lock, dependencyRoot);
  return {
    codeIdentity,
    lockHash,
    packageRoot: snapshot.packageRoot,
    automationDir: path.join(snapshot.packageRoot, "extensions", "deadloop", "automations"),
    dependencyRoot,
    created: snapshot.created,
  };
}
