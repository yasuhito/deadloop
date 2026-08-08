const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createHash } = require("node:crypto") as typeof import("node:crypto");

import type { CommandRunner, JsonObject } from "./automation-driver-kit";

class IncompletePrHistoryObservationError extends Error {
  readonly code = "incomplete_pr_history_observation";
  readonly collection: string;

  constructor(collection: string, detail: string) {
    super(`PR history observation is incomplete for ${collection}: ${detail}`);
    this.name = "IncompletePrHistoryObservationError";
    this.collection = collection;
  }
}

type CanonicalHistory = {
  pullRequest: JsonObject;
  commits: JsonObject[];
  diff: { sha256: string; bytes: number };
  conversationComments: JsonObject[];
  submittedReviews: JsonObject[];
  inlineReviewComments: JsonObject[];
};

type PrHistoryObservation = {
  schemaVersion: 1;
  repository: string;
  pullRequestNumber: number;
  observedAt: string;
  revision: string;
  history: CanonicalHistory;
  evidence: { exactDiff: string };
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function identity(value: JsonObject): string {
  const id = value.id ?? value.node_id;
  if (id === null || id === undefined || String(id) === "") {
    throw new IncompletePrHistoryObservationError("item", "an item has no stable GitHub identity");
  }
  return String(id);
}

function author(value: JsonObject): string {
  return text(value.user?.login ?? value.author?.login);
}

function canonicalComment(value: JsonObject): JsonObject {
  return {
    id: identity(value),
    nodeId: text(value.node_id),
    author: author(value),
    body: text(value.body),
    createdAt: text(value.created_at ?? value.createdAt),
    updatedAt: text(value.updated_at ?? value.updatedAt),
  };
}

function canonicalReview(value: JsonObject): JsonObject {
  return {
    ...canonicalComment(value),
    state: text(value.state),
    commitId: text(value.commit_id),
    submittedAt: text(value.submitted_at),
  };
}

function canonicalInlineComment(value: JsonObject): JsonObject {
  return {
    ...canonicalComment(value),
    path: text(value.path),
    commitId: text(value.commit_id),
    originalCommitId: text(value.original_commit_id),
    line: value.line ?? null,
    originalLine: value.original_line ?? null,
    side: text(value.side),
    startLine: value.start_line ?? null,
    startSide: text(value.start_side),
    inReplyToId: value.in_reply_to_id === undefined ? null : text(value.in_reply_to_id),
  };
}

function paginated(runner: CommandRunner, repository: string, endpoint: string, collection: string): JsonObject[] {
  let pages: unknown;
  try {
    pages = runner.runJson(["gh", "api", "--paginate", "--slurp", `repos/${repository}/${endpoint}?per_page=100`]);
  } catch (error) {
    throw new IncompletePrHistoryObservationError(collection, error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new IncompletePrHistoryObservationError(collection, "paginated GitHub response is not an array of pages");
  }
  const values = pages.flat();
  if (values.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
    throw new IncompletePrHistoryObservationError(collection, "a page contains an invalid item");
  }
  return values as JsonObject[];
}

function paginatedCommits(runner: CommandRunner, repository: string, pullRequestNumber: number): JsonObject[] {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new IncompletePrHistoryObservationError("commits", "repository must be owner/name");
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(first:100,after:$endCursor){nodes{commit{oid}}pageInfo{hasNextPage endCursor}}}}}`;
  let pages: unknown;
  try {
    pages = runner.runJson([
      "gh", "api", "graphql", "--paginate", "--slurp",
      "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pullRequestNumber}`,
    ]);
  } catch (error) {
    throw new IncompletePrHistoryObservationError("commits", error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new IncompletePrHistoryObservationError("commits", "GraphQL pagination returned no pages");
  }
  const commits: JsonObject[] = [];
  for (const page of pages as JsonObject[]) {
    const connection = page?.data?.repository?.pullRequest?.commits;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new IncompletePrHistoryObservationError("commits", "GraphQL page is missing its commits connection");
    }
    for (const node of connection.nodes) commits.push({ sha: text(node?.commit?.oid) });
  }
  const last = (pages as JsonObject[]).at(-1)?.data?.repository?.pullRequest?.commits?.pageInfo;
  if (last?.hasNextPage !== false) {
    throw new IncompletePrHistoryObservationError("commits", "GraphQL pagination ended before the final page");
  }
  return commits;
}

function sorted(values: JsonObject[]): JsonObject[] {
  return [...values].sort((left, right) => identity(left).localeCompare(identity(right), "en", { numeric: true }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function observePrHistory(repository: string, pullRequestNumber: number, runner: CommandRunner): PrHistoryObservation {
  let pull: JsonObject;
  let diff: string;
  try {
    pull = runner.runJson(["gh", "api", `repos/${repository}/pulls/${pullRequestNumber}`]);
    diff = runner.runText([
      "gh", "api", `repos/${repository}/pulls/${pullRequestNumber}`,
      "-H", "Accept: application/vnd.github.diff",
    ]);
  } catch (error) {
    throw new IncompletePrHistoryObservationError("pullRequest", error instanceof Error ? error.message : String(error));
  }
  const head = text(pull?.head?.sha);
  const base = text(pull?.base?.sha);
  if (!head || !base) throw new IncompletePrHistoryObservationError("pullRequest", "head or base revision is missing");

  const commits = paginatedCommits(runner, repository, pullRequestNumber).map((commit) => {
    const sha = text(commit.sha);
    if (!sha) throw new IncompletePrHistoryObservationError("commits", "a commit SHA is missing");
    return { sha };
  });
  const conversationComments = sorted(paginated(
    runner, repository, `issues/${pullRequestNumber}/comments`, "conversationComments",
  )).map(canonicalComment);
  const submittedReviews = sorted(paginated(
    runner, repository, `pulls/${pullRequestNumber}/reviews`, "submittedReviews",
  )).map(canonicalReview);
  const inlineReviewComments = sorted(paginated(
    runner, repository, `pulls/${pullRequestNumber}/comments`, "inlineReviewComments",
  )).map(canonicalInlineComment);
  const history: CanonicalHistory = {
    pullRequest: {
      number: Number(pull.number ?? pullRequestNumber),
      state: text(pull.state),
      headRef: text(pull.head?.ref),
      headSha: head,
      baseRef: text(pull.base?.ref),
      baseSha: base,
    },
    commits,
    diff: { sha256: sha256(diff), bytes: Buffer.byteLength(diff) },
    conversationComments,
    submittedReviews,
    inlineReviewComments,
  };
  return {
    schemaVersion: 1,
    repository,
    pullRequestNumber,
    observedAt: new Date().toISOString(),
    revision: sha256(`${JSON.stringify(history)}\n`),
    history,
    evidence: { exactDiff: diff },
  };
}

function comparePrHistoryObservations(expected: PrHistoryObservation, actual: PrHistoryObservation) {
  const changed: string[] = (Object.keys(expected.history) as Array<keyof CanonicalHistory>)
    .filter((key) => JSON.stringify(expected.history[key]) !== JSON.stringify(actual.history[key]));
  if (expected.repository !== actual.repository || expected.pullRequestNumber !== actual.pullRequestNumber) changed.unshift("identity");
  return changed.length === 0 && expected.revision === actual.revision
    ? { kind: "unchanged" as const, revision: expected.revision, changed: [] as string[] }
    : { kind: "stale" as const, expectedRevision: expected.revision, actualRevision: actual.revision, changed };
}

function advancePrHistoryAfterDeterministicComment(
  expected: PrHistoryObservation,
  actual: PrHistoryObservation,
  createdComment?: { id: string; author: string; body: string },
) {
  const comparison = comparePrHistoryObservations(expected, actual);
  if (comparison.kind === "unchanged") return { kind: "accepted" as const, observation: actual };
  if (comparison.changed.length !== 1 || comparison.changed[0] !== "conversationComments") {
    return { kind: "stale" as const, comparison };
  }
  const previous = new Map(expected.history.conversationComments.map((comment) => [String(comment.id), JSON.stringify(comment)]));
  const added = actual.history.conversationComments.filter((comment) => !previous.has(String(comment.id)));
  const retained = actual.history.conversationComments.filter((comment) => previous.has(String(comment.id)));
  const retainedUnchanged = retained.length === previous.size
    && retained.every((comment) => previous.get(String(comment.id)) === JSON.stringify(comment));
  if (!retainedUnchanged || added.length !== 1) {
    return { kind: "stale" as const, comparison };
  }
  if (createdComment && (
    added[0].id !== createdComment.id
    || added[0].author !== createdComment.author
    || added[0].body !== createdComment.body
  )) {
    return { kind: "stale" as const, comparison };
  }
  if (!createdComment) return { kind: "stale" as const, comparison };
  return { kind: "accepted" as const, observation: actual };
}

function writePrHistoryObservation(file: string, observation: PrHistoryObservation): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(observation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readPrHistoryObservation(file: string): PrHistoryObservation {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new IncompletePrHistoryObservationError("attemptRevision", error instanceof Error ? error.message : String(error));
  }
  const observation = value as Partial<PrHistoryObservation>;
  const history = observation.history as Partial<CanonicalHistory> | undefined;
  if (
    observation.schemaVersion !== 1
    || typeof observation.repository !== "string"
    || !Number.isInteger(observation.pullRequestNumber)
    || typeof observation.revision !== "string"
    || !history
    || !Array.isArray(history.commits)
    || !Array.isArray(history.conversationComments)
    || !Array.isArray(history.submittedReviews)
    || !Array.isArray(history.inlineReviewComments)
    || !history.pullRequest
    || !history.diff
    || typeof observation.evidence?.exactDiff !== "string"
    || sha256(`${JSON.stringify(history)}\n`) !== observation.revision
    || sha256(observation.evidence.exactDiff) !== history.diff.sha256
    || Buffer.byteLength(observation.evidence.exactDiff) !== history.diff.bytes
  ) {
    throw new IncompletePrHistoryObservationError("attemptRevision", "stored observation is invalid or corrupt");
  }
  return observation as PrHistoryObservation;
}

module.exports = {
  IncompletePrHistoryObservationError,
  advancePrHistoryAfterDeterministicComment,
  comparePrHistoryObservations,
  observePrHistory,
  readPrHistoryObservation,
  writePrHistoryObservation,
};
