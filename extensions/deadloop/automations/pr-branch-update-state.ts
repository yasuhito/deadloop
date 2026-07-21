const { createHash } = require("node:crypto") as typeof import("node:crypto");

type JsonObject = Record<string, any>;

const BRANCH_UPDATE_MARKER_RE = /<!--\s*deadloop:branch-update-attempt\s+key=([0-9a-f]+)\s+head=([0-9a-f]+)\s+base=([0-9a-f]+)\s*-->/gi;

function branchUpdateRetryKey(headOid: string, baseOid: string): string {
  return createHash("sha256").update(`${headOid.toLowerCase()}\n${baseOid.toLowerCase()}\n`).digest("hex").slice(0, 20);
}

function renderBranchUpdateMarker(headOid: string, baseOid: string): string {
  const key = branchUpdateRetryKey(headOid, baseOid);
  return `<!-- deadloop:branch-update-attempt key=${key} head=${headOid.toLowerCase()} base=${baseOid.toLowerCase()} -->`;
}

function branchUpdateAttemptExists(comments: JsonObject[], headOid: string, baseOid: string): boolean {
  const key = branchUpdateRetryKey(headOid, baseOid);
  return comments.some((comment) => {
    const body = String(comment?.body || "");
    BRANCH_UPDATE_MARKER_RE.lastIndex = 0;
    for (let match = BRANCH_UPDATE_MARKER_RE.exec(body); match; match = BRANCH_UPDATE_MARKER_RE.exec(body)) {
      if (match[1].toLowerCase() === key) return true;
    }
    return false;
  });
}

module.exports = { branchUpdateAttemptExists, branchUpdateRetryKey, renderBranchUpdateMarker };
