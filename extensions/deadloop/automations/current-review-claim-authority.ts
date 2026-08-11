const { loadCurrentReviewClaimConfiguration } = require("../../../src/current-review-claim-config.cjs");
const { assertClaimMatchesCurrentConfiguration } = require("./pr-review-claim.ts");

type EnabledAuthority = {
  repoPath: string;
  githubRepo: string;
  githubRepositoryId: string;
  baseBranch?: string;
  automationLogin?: string;
};

function assertCurrentReviewClaimAuthority(
  claim: Record<string, unknown>,
  stateDir: string,
  enabled: EnabledAuthority,
  authenticatedLogin: string,
  load = loadCurrentReviewClaimConfiguration,
): Record<string, unknown> {
  const current = load(stateDir, enabled, authenticatedLogin);
  assertClaimMatchesCurrentConfiguration(claim, current);
  return current;
}

module.exports = { assertCurrentReviewClaimAuthority };
