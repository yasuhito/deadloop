import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDoctorSnapshot, formatDoctorReport } from "../src/doctor";
import { normalizeProject } from "../src/core";
import { discoverVerificationCandidates } from "../src/required-verification";

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-verification-candidates-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function doctor(root: string): string {
  const project = normalizeProject({ id: "demo", repoPath: root, githubRepo: "owner/repo" });
  return formatDoctorReport(buildDoctorSnapshot({
    cwd: root,
    projects: [project],
    selectedProject: project,
    verificationCandidates: discoverVerificationCandidates({ repositoryRoot: root }),
  }));
}

describe("verification candidate discovery", () => {
  it("discovers an aggregate package script with its source", () => {
    const root = repository({ "package.json": JSON.stringify({ scripts: { check: "npm test && npm run lint" } }) });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({
      status: "found",
      candidates: [{ category: "aggregate", command: "npm run check", source: { kind: "package_manifest", location: "package.json#scripts.check" } }],
    });
  });

  it.each(["test", "lint", "typecheck"])("discovers the individual %s package script", (script) => {
    const root = repository({ "package.json": JSON.stringify({ scripts: { [script]: "tool" } }) });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({
      status: "found",
      candidates: [{ category: "individual", command: `npm run ${script}` }],
    });
  });

  it("preserves a GitHub Actions run step working directory", () => {
    const root = repository({
      ".github/workflows/ci.yml": `jobs:\n    test:\n        steps:\n            - run: bundle exec rake test\n              working-directory: web # frontend workspace\n`,
    });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({
      status: "found",
      candidates: [{ command: "bundle exec rake test", workingDirectory: "web", source: { kind: "github_actions", location: ".github/workflows/ci.yml#jobs.test.steps[0].run" } }],
    });
  });

  it("applies job working-directory defaults regardless of key order", () => {
    const root = repository({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - run: npm test\n    defaults:\n      run:\n        working-directory: web\n`,
    });

    const result = discoverVerificationCandidates({ repositoryRoot: root });
    expect(result.status === "found" ? result.candidates[0]?.workingDirectory : undefined).toBe("web");
  });

  it("preserves explicit GitHub Actions execution context", () => {
    const root = repository({
      ".github/workflows/ci.yml": `env:\n  CI: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    container: node:22\n    strategy:\n      matrix:\n        node: [20, 22]\n    services:\n      postgres:\n        image: postgres:16\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n        shell: bash\n        env:\n          NODE_ENV: test\n      - uses: actions/upload-artifact@v4\n`,
    });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({
      status: "found",
      candidates: [{ executionContext: { shell: "bash", workflowEnv: { CI: true }, stepEnv: { NODE_ENV: "test" }, matrix: { node: [20, 22] }, runsOn: "ubuntu-latest", container: "node:22", services: { postgres: { image: "postgres:16" } }, setupSteps: [{ uses: "actions/setup-node@v4", with: { "node-version": 22 } }] } }],
    });
  });

  it("does not confuse nested env.run with the step command", () => {
    const root = repository({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - env:\n          run: not-the-step-command\n        run: npm test\n`,
    });

    const result = discoverVerificationCandidates({ repositoryRoot: root });
    expect(result.status === "found" ? result.candidates[0]?.command : undefined).toBe("npm test");
  });

  it("keeps multiple CI run steps as separate candidates", () => {
    const root = repository({
      ".github/workflows/ci.yaml": `jobs:\n  verify:\n    steps:\n      - run: npm ci\n      - run: npm test\n`,
    });
    const result = discoverVerificationCandidates({ repositoryRoot: root });

    expect(result.status === "found" ? result.candidates.map((candidate) => candidate.command) : []).toEqual(["npm ci", "npm test"]);
  });

  it("distinguishes no candidates from discovery failure", () => {
    const root = repository({ "package.json": JSON.stringify({ name: "demo", scripts: { start: "node app.js" } }) });

    expect(discoverVerificationCandidates({ repositoryRoot: root }).status).toBe("none");
  });

  it("returns a typed discovery failure for an invalid manifest", () => {
    const root = repository({ "package.json": "{" });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({ status: "error", reason: "manifest_parse_error", source: "package.json" });
  });

  it("returns a typed discovery failure for an invalid workflow", () => {
    const root = repository({ ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n    broken: [\n" });

    expect(discoverVerificationCandidates({ repositoryRoot: root })).toMatchObject({ status: "error", reason: "workflow_parse_error", source: ".github/workflows/ci.yml" });
  });

  it("shows candidates without resolving no_source", () => {
    const root = repository({ "package.json": JSON.stringify({ scripts: { check: "npm test" } }) });

    expect(doctor(root)).toContain("requiredVerification: blocked; reason=no_source");
  });

  it("labels the no-candidate doctor outcome distinctly", () => {
    const root = repository({ "package.json": JSON.stringify({ name: "demo" }) });

    expect(doctor(root)).toContain("verificationCandidates: none");
  });

  it("labels a discovery failure with its typed reason", () => {
    const root = repository({ "package.json": "{" });

    expect(doctor(root)).toContain("verificationCandidates: error; reason=manifest_parse_error; source=package.json");
  });
});
