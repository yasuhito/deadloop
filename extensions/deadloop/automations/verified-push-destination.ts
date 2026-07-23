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
  githubRepositoryId: string,
  timeoutMs: number,
): string {
  const result = ops.run(["git", "-C", repo, "remote", "get-url", "--push", "--all", remote], timeoutMs);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `push remote could not be resolved: ${remote}`).trim());
  }
  const urls = result.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error(`push remote ${remote} does not resolve exclusively to ${githubRepo}`);
  for (const url of urls) {
    const identity = githubRepoFromRemote(url);
    const view = identity ? ops.run(["gh", "repo", "view", identity, "--json", "id"], timeoutMs) : null;
    if (view?.status !== 0) {
      throw new Error((view?.stderr || view?.stdout || `GitHub repository identity could not be resolved for ${identity || url}`).trim());
    }
    try {
      if (String(JSON.parse(view?.stdout || "{}").id || "") !== githubRepositoryId) {
        throw new Error(`push remote ${remote} does not resolve exclusively to ${githubRepo}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("push remote ")) throw error;
      throw new Error(`GitHub repository identity could not be resolved for ${identity}`);
    }
  }
  return urls[0];
}

module.exports = { resolveVerifiedPushDestination };
