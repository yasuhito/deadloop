#!/usr/bin/env node

const { projectCheckMain } = require("../../../src/project-check.ts");

projectCheckMain().catch((error: unknown) => {
  console.error(`run-project-check.ts: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
