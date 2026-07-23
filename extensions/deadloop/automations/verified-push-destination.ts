type CommandResult = { status: number; stdout: string; stderr: string };
type CommandOps = { run(args: string[], timeoutMs?: number): CommandResult };

function githubRepoFromRemote(remote: string): string {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  return match ? match[1] : "";
}

function resolveVerifiedPushDestination(
  ops: CommandOps,
  repo: string,
  remote: string,
  githubRepo: string,
  timeoutMs: number,
): string {
  const result = ops.run(["git", "-C", repo, "remote", "get-url", "--push", "--all", remote], timeoutMs);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `push remote could not be resolved: ${remote}`).trim());
  }
  const urls = result.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const expected = githubRepo.toLowerCase();
  if (urls.length === 0 || urls.some((url) => githubRepoFromRemote(url).toLowerCase() !== expected)) {
    throw new Error(`push remote ${remote} does not resolve exclusively to ${githubRepo}`);
  }
  return urls[0];
}

module.exports = { resolveVerifiedPushDestination };
