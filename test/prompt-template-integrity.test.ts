import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeProject, templateValues } from "../src/core";

const automationDir = path.join(process.cwd(), "extensions/pi-looper/automations");
const placeholderPattern = /\{\{\s*([\w.-]+)\s*\}\}/g;

function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(placeholderPattern)].map((match) => match[1]);
}

describe("prompt template integrity", () => {
  it("provides template values for every prompt placeholder", () => {
    const promptFiles = fs
      .readdirSync(automationDir)
      .filter((file) => file.endsWith(".prompt.md"))
      .sort();
    const project = normalizeProject({
      id: "template-integrity",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      automations: promptFiles.map((promptFile) => ({
        id: `template-integrity:${promptFile}`,
        name: promptFile,
        promptFile,
      })),
    });

    const missingPlaceholders = promptFiles.flatMap((promptFile, index) => {
      const promptPath = path.join(automationDir, promptFile);
      const template = fs.readFileSync(promptPath, "utf8");
      const providedKeys = new Set(Object.keys(templateValues(project, project.automations[index], automationDir)));
      return [...new Set(extractPlaceholders(template))]
        .filter((placeholder) => !providedKeys.has(placeholder))
        .map((placeholder) => `${promptFile}: ${placeholder}`);
    });

    expect(missingPlaceholders).toEqual([]);
  });
});
