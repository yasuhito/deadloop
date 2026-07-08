import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/pi-looper/automations");

type PromptBudget = {
  file: string;
  budgetCharacters: number;
  currentApproxCharacters: string;
};

function promptCharacterCount(file: string): number {
  return fs.readFileSync(path.join(automationDir, file), "utf8").length;
}

const promptBudgets: PromptBudget[] = [
  {
    file: "issue-coordinator.prompt.md",
    budgetCharacters: 4_000,
    currentApproxCharacters: "1.6k",
  },
  {
    file: "pr-reviewer.prompt.md",
    budgetCharacters: 25_000,
    currentApproxCharacters: "23.7k",
  },
];

describe("automation prompt token hygiene budgets", () => {
  for (const budget of promptBudgets) {
    it(`${budget.file} stays within its prompt budget (current approx ${budget.currentApproxCharacters} chars)`, () => {
      const actualCharacters = promptCharacterCount(budget.file);

      expect(
        actualCharacters,
        `${budget.file} is ${actualCharacters} chars; budget is ${budget.budgetCharacters} chars. ` +
          "Move deterministic workflow text into scripts before increasing this budget.",
      ).toBeLessThanOrEqual(budget.budgetCharacters);
    });
  }
});
