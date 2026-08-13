#!/usr/bin/env node
// Run a project validation command while keeping deadloop's generated evidence
// out of recursive formatters. CommonJS-shaped so Node can execute this file.

const { projectCheckMain } = require("../../../src/project-check.ts") as { projectCheckMain: () => Promise<void> };

if (require.main === module) {
  projectCheckMain().catch((error: unknown) => {
    process.stderr.write(`run-project-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
