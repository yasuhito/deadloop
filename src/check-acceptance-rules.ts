import fs from "node:fs";
import path from "node:path";

import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType, type GherkinDocument, type Scenario } from "@cucumber/messages";
import ts from "typescript";

export type SourceFile = { path: string; source: string };
export type AcceptanceSource = {
  config: SourceFile;
  features: SourceFile[];
  stepDefinitions: SourceFile[];
  helpers: SourceFile[];
};

function scenarios(document: GherkinDocument): Scenario[] {
  const found: Scenario[] = [];
  for (const child of document.feature?.children ?? []) {
    if (child.scenario) found.push(child.scenario);
    for (const ruleChild of child.rule?.children ?? []) if (ruleChild.scenario) found.push(ruleChild.scenario);
  }
  return found;
}

function checkFeature(file: SourceFile): string[] {
  const errors: string[] = [];
  if (/^\s*---(?:\r?\n|$)/.test(file.source)) errors.push(`${file.path}: front matter is not allowed`);
  const envelopes = generateMessages(file.source, file.path, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_MARKDOWN, {
    defaultDialect: "ja",
    includeGherkinDocument: true,
    includePickles: false,
    includeSource: false,
    newId: IdGenerator.incrementing(),
  });
  for (const envelope of envelopes) {
    if (envelope.parseError)
      errors.push(`${file.path}:${envelope.parseError.source?.location.line ?? 1}: ${envelope.parseError.message}`);
    if (!envelope.gherkinDocument) continue;
    for (const scenario of scenarios(envelope.gherkinDocument)) {
      const resultCount = scenario.steps.filter((step) => step.keywordType === "Outcome").length;
      if (resultCount !== 1) {
        errors.push(
          `${file.path}:${scenario.location.line}: scenario must contain exactly one result step (found ${resultCount})`,
        );
      }
      let resultSeen = false;
      for (const step of scenario.steps) {
        if (step.keywordType === "Outcome") resultSeen = true;
        else if (resultSeen && step.keywordType === "Conjunction") {
          errors.push(`${file.path}:${step.location.line}: And/But after Then is not allowed`);
        }
      }
    }
  }
  return errors;
}

function assertionBindings(sourceFile: ts.SourceFile): { functions: Set<string>; namespaces: Set<string> } {
  const functions = new Set<string>(["expect"]);
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.startsWith("node:assert")) continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      namespaces.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) functions.add(element.name.text);
    }
  }
  return { functions, namespaces };
}

function isAssertionCall(node: ts.CallExpression, bindings: ReturnType<typeof assertionBindings>): boolean {
  if (ts.isIdentifier(node.expression)) return bindings.functions.has(node.expression.text);
  if (ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression;
    if (ts.isIdentifier(owner) && bindings.namespaces.has(owner.text)) return true;
    if (ts.isCallExpression(owner)) return isAssertionCall(owner, bindings);
  }
  return false;
}

function countAssertions(root: ts.FunctionLikeDeclaration, bindings: ReturnType<typeof assertionBindings>): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && isAssertionCall(node, bindings)) count += 1;
    ts.forEachChild(node, visit);
  };
  if (root.body) visit(root.body);
  return count;
}

function checkStepDefinitions(file: SourceFile): string[] {
  const errors: string[] = [];
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = assertionBindings(sourceFile);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Given", "When", "Then"].includes(node.expression.text)
    ) {
      const kind = node.expression.text;
      const implementation = node.arguments.find(
        (argument) => ts.isFunctionExpression(argument) || ts.isArrowFunction(argument),
      );
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const count = implementation && ts.isFunctionLike(implementation) ? countAssertions(implementation, bindings) : 0;
      if (kind === "Then" && count !== 1) {
        errors.push(
          `${file.path}:${line}: Then step definition must contain exactly one direct assertion (found ${count})`,
        );
      } else if (kind !== "Then" && count !== 0) {
        errors.push(`${file.path}:${line}: ${kind} step definition must not contain assertions`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function checkHelper(file: SourceFile): string[] {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = assertionBindings(sourceFile);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isAssertionCall(node, bindings)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found ? [`${file.path}: assertions are not allowed in acceptance helpers`] : [];
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function hasJapaneseLanguage(config: SourceFile): boolean {
  const sourceFile = ts.createSourceFile(config.path, config.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const assignment = statement.expression;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(assignment.right))
      continue;
    if (assignment.left.getText(sourceFile) !== "module.exports") continue;
    const defaultProfile = objectProperty(assignment.right, "default");
    if (!defaultProfile || !ts.isObjectLiteralExpression(defaultProfile)) return false;
    const language = objectProperty(defaultProfile, "language");
    return Boolean(language && ts.isStringLiteral(language) && language.text === "ja");
  }
  return false;
}

export function checkAcceptanceRules(input: AcceptanceSource): string[] {
  const errors = hasJapaneseLanguage(input.config)
    ? []
    : [`${input.config.path}: Cucumber language must be explicitly set to 'ja'`];
  for (const feature of input.features) errors.push(...checkFeature(feature));
  for (const steps of input.stepDefinitions) errors.push(...checkStepDefinitions(steps));
  for (const helper of input.helpers) errors.push(...checkHelper(helper));
  if (input.features.length === 0) errors.push("acceptance/features: at least one .feature.md file is required");
  return errors;
}

function filesBelow(root: string, predicate: (file: string) => boolean): SourceFile[] {
  if (!fs.existsSync(root)) return [];
  const found: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (predicate(file)) found.push({ path: file, source: fs.readFileSync(file, "utf8") });
    }
  };
  visit(root);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export function loadAcceptanceSources(cwd = process.cwd()): AcceptanceSource {
  const configPath = path.join(cwd, "cucumber.cjs");
  return {
    config: { path: "cucumber.cjs", source: fs.readFileSync(configPath, "utf8") },
    features: filesBelow(path.join(cwd, "acceptance/features"), (file) => file.endsWith(".feature.md")),
    stepDefinitions: filesBelow(path.join(cwd, "acceptance/steps"), (file) => file.endsWith(".ts")),
    helpers: filesBelow(path.join(cwd, "acceptance/support"), (file) => file.endsWith(".ts")),
  };
}

if (require.main === module) {
  const errors = checkAcceptanceRules(loadAcceptanceSources());
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
