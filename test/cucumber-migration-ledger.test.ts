import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ledger = readFileSync("docs/cucumber-migration-ledger.md", "utf8");
const rows = [...ledger.matchAll(/^\| (T\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)].map((match) => ({
  id: match[1],
  initial: match[2].trim(),
  final: match[3].trim(),
  evidence: match[4].trim(),
}));

const expectedIds = Array.from({ length: 399 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`);
const deletionCandidates = ["T043", "T049", "T055", "T056", "T057", "T072", "T366", "T367", "T368"];
const cucumberResults = new Set(["移行済み", "Vitest 継続へ再分類", "同じ保証へ統合"]);

describe("Cucumber migration ledger", () => {
  it("tracks every original classification ID exactly once", () => {
    expect(rows.map(({ id }) => id)).toEqual(expectedIds);
  });

  it("gives every Cucumber candidate a final migration result", () => {
    expect(rows.filter(({ initial }) => initial === "Cucumber候補").every(({ final }) => cucumberResults.has(final))).toBe(
      true,
    );
  });

  it("records every deletion candidate as deleted", () => {
    expect(rows.filter(({ id }) => deletionCandidates.includes(id)).map(({ final }) => final)).toEqual(
      deletionCandidates.map(() => "削除済み"),
    );
  });

  it("does not treat the original classification as migration evidence", () => {
    expect(
      rows
        .filter(({ initial }) => initial === "Cucumber候補")
        .every(({ evidence }) => evidence !== "[cucumber-test-classification.md](cucumber-test-classification.md)"),
    ).toBe(true);
  });
});
