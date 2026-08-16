import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

// Every gate that asks whether a worktree holds uncommitted work answers with
// hasUncommittedWork and UNCOMMITTED_WORK_STATUS_ARGS from
// src/agent-scratch-area.cjs, and no prompt hands that judgment to a language
// model. This file enforces both halves mechanically, because the same rule has
// now been copied by hand three times and missed twice: once in the gates
// themselves, once in the agent prompts. See
// docs/adr/0025-every-uncommitted-work-gate-shares-one-implementation.md.

export type SourceFile = { path: string; source: string };

// The only places allowed to spell a git status invocation out. Each entry is a
// recorded decision, not an exemption for convenience.
const ALLOWED_STATUS_INVOCATIONS = new Map([
  ["src/agent-scratch-area.cjs", "defines the shared argument list"],
  ["src/enablement-verification.ts", "proves a throwaway worktree is pristine, which counts ignored files too"],
]);

// A git status invocation names the subcommand and at least one of its output
// options. `herdr status server` and `gh auth status` name no option and are
// not this judgment.
const STATUS_OUTPUT_OPTION = /^--(?:porcelain|short|untracked-files)/;

// Wording that asks an agent to decide for itself whether a worktree is clean.
// The agent runs its own git status, which cannot know the agent scratch areas.
const PROMPT_JUDGMENT_PHRASES = ["clean worktree", "worktree is clean", "uncommitted", "dirty worktree", "git status"];

function parse(file: SourceFile): ts.SourceFile {
  const kind = file.path.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isGitStatusArguments(node: ts.Node): boolean {
  if (!ts.isArrayLiteralExpression(node)) return false;
  const literals = node.elements.filter(ts.isStringLiteral).map((element) => element.text);
  return literals.includes("status") && literals.some((literal) => STATUS_OUTPUT_OPTION.test(literal));
}

/** The name a function-like node is declared under, whether by statement, variable, property, or method. */
function declaredName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

function isPromptFunction(node: ts.Node): boolean {
  const name = declaredName(node);
  return name !== null && name.endsWith("Prompt");
}

/** The literal text a node contributes to a string, including each piece of a template. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

function checkFile(file: SourceFile): string[] {
  const errors: string[] = [];
  const source = parse(file);
  const allowedReason = ALLOWED_STATUS_INVOCATIONS.get(file.path);
  const visit = (node: ts.Node, insidePrompt: boolean): void => {
    if (!allowedReason && isGitStatusArguments(node)) {
      errors.push(
        `${file.path}:${lineOf(source, node)}: a git status judgment must use UNCOMMITTED_WORK_STATUS_ARGS and hasUncommittedWork from src/agent-scratch-area.cjs`,
      );
    }
    const nowInsidePrompt = insidePrompt || isPromptFunction(node);
    const text = nowInsidePrompt ? literalText(node) : null;
    if (text) {
      for (const phrase of PROMPT_JUDGMENT_PHRASES) {
        const index = text.toLowerCase().indexOf(phrase);
        if (index < 0) continue;
        // A template piece starts at the substitution that precedes it, so the
        // wording is reported where a reader will find it, not where the piece began.
        const line = lineOf(source, node) + text.slice(0, index).split("\n").length - 1;
        errors.push(`${file.path}:${line}: a prompt must not ask an agent to judge uncommitted work ("${phrase}")`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, nowInsidePrompt));
  };
  visit(source, false);
  return errors;
}

export function checkUncommittedWorkJudgments(files: SourceFile[]): string[] {
  return files.flatMap(checkFile);
}

function filesBelow(cwd: string, root: string): SourceFile[] {
  const absoluteRoot = path.join(cwd, root);
  if (!fs.existsSync(absoluteRoot)) return [];
  const found: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith(".ts") || file.endsWith(".cjs")) {
        // Slash-separated so the recorded exceptions read the same on every platform.
        const relative = path.relative(cwd, file).split(path.sep).join("/");
        found.push({ path: relative, source: fs.readFileSync(file, "utf8") });
      }
    }
  };
  visit(absoluteRoot);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** The shipped code. Tests and acceptance helpers are not gates and are not scanned. */
export function loadUncommittedWorkJudgmentSources(cwd = process.cwd()): SourceFile[] {
  return [...filesBelow(cwd, "src"), ...filesBelow(cwd, "extensions")];
}

if (require.main === module) {
  const errors = checkUncommittedWorkJudgments(loadUncommittedWorkJudgmentSources());
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
