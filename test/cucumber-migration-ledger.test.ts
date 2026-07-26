import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ledger = readFileSync("docs/cucumber-migration-ledger.md", "utf8");
const classification = readFileSync("docs/cucumber-test-classification.md", "utf8");
const boundedRecoveryMigration = readFileSync("docs/cucumber-bounded-pr-recovery-migration.md", "utf8");
const rows = [...ledger.matchAll(/^\| (T\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)].map((match) => ({
  id: match[1],
  initial: match[2].trim(),
  final: match[3].trim(),
  evidence: match[4].trim(),
}));

const expectedIds = Array.from({ length: 399 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`);
const migratedProjectCheckIds = Array.from({ length: 9 }, (_, index) => `T${357 + index}`);
const originalClassifications = [
  ...classification.matchAll(/^\| (T\d{3}) \| .*?\| \*\*(Cucumber候補|Vitest継続|削除候補)\*\* \|/gm),
].map((match) => ({ id: match[1], initial: match[2] }));
const expectedOriginalClassifications = [
  ...originalClassifications,
  ...migratedProjectCheckIds.map((id) => ({ id, initial: "Cucumber候補" })),
].sort(({ id: left }, { id: right }) => left.localeCompare(right));
const deletionCandidates = ["T043", "T049", "T055", "T056", "T057", "T072", "T366", "T367", "T368"];
const cucumberResults = new Set(["移行済み", "Vitest 継続へ再分類", "同じ保証へ統合"]);
const boundedRecoveryResults = [
  ...boundedRecoveryMigration.matchAll(/^\| ((?:T\d{3})(?:, T\d{3})*) \| [^|]+ \| ([^|]+) \|/gm),
].flatMap((match) =>
  match[1].split(", ").map((id) => ({
    id,
    final: match[2].trim().split("（")[0],
  })),
);
const focusedVitestIds = [
  "T001",
  "T052",
  "T053",
  "T094",
  "T116",
  "T129",
  "T189",
  "T191",
  "T192",
  "T193",
  "T194",
  "T195",
  "T196",
  "T198",
];

describe("Cucumber migration ledger", () => {
  it("tracks every original classification ID exactly once", () => {
    expect(rows.map(({ id }) => id)).toEqual(expectedIds);
  });

  it("preserves every original classification in the migration ledger", () => {
    expect(rows.map(({ id, initial }) => ({ id, initial }))).toEqual(expectedOriginalClassifications);
  });

  it("keeps the approved original classification counts", () => {
    expect(
      Object.fromEntries(
        ["Cucumber候補", "Vitest継続", "削除候補"].map((initial) => [
          initial,
          expectedOriginalClassifications.filter((row) => row.initial === initial).length,
        ]),
      ),
    ).toEqual({ Cucumber候補: 217, Vitest継続: 173, 削除候補: 9 });
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

  it("agrees with every final result in the bounded recovery migration record", () => {
    const ledgerResults = new Map(rows.map(({ id, final }) => [id, final]));

    expect(
      boundedRecoveryResults.filter(({ id, final }) => ledgerResults.get(id) !== final),
    ).toEqual([]);
  });

  it("records focused Vitest classifications resolved by their migration records", () => {
    expect(rows.filter(({ id }) => focusedVitestIds.includes(id)).map(({ final }) => final)).toEqual(
      focusedVitestIds.map(() => "Vitest 継続へ再分類"),
    );
  });

  it("classifies T209 as retained in Vitest", () => {
    expect(rows.find(({ id }) => id === "T209")?.final).toBe("Vitest 継続へ再分類");
  });

  it("records T209 evidence for the candidate-free coordinator transition", () => {
    expect(rows.find(({ id }) => id === "T209")?.evidence).toContain("`skip`");
  });

  it("classifies T210 as retained in Vitest", () => {
    expect(rows.find(({ id }) => id === "T210")?.final).toBe("Vitest 継続へ再分類");
  });

  it("records T210 evidence for the cleanup-only coordinator transition", () => {
    expect(rows.find(({ id }) => id === "T210")?.evidence).toContain("`cleanup_applied`");
  });

  it("classifies T220 as retained in Vitest", () => {
    expect(rows.find(({ id }) => id === "T220")?.final).toBe("Vitest 継続へ再分類");
  });

  it("records T220 evidence for the project-check prompt boundary", () => {
    expect(rows.find(({ id }) => id === "T220")?.evidence).toContain("`run-project-check.ts`");
  });

  it("does not treat the original classification as migration evidence", () => {
    expect(
      rows
        .filter(({ initial }) => initial === "Cucumber候補")
        .every(({ evidence }) => evidence !== "[cucumber-test-classification.md](cucumber-test-classification.md)"),
    ).toBe(true);
  });
});
