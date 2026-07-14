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
  const lines = file.source.split(/\r?\n/);
  if (/^(?:---|\+\+\+)(?:\r?\n|$)/.test(file.source)) errors.push(`${file.path}: front matter is not allowed`);
  if (/^\s*#\s*language\s*:/.test(lines[0] ?? "")) {
    errors.push(`${file.path}:1: language directives are not allowed`);
  }
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
    const feature = envelope.gherkinDocument.feature;
    if (!feature?.keyword || feature.location.line !== 1) {
      errors.push(`${file.path}:1: file must start with an explicit Feature heading`);
    }
    for (const scenario of scenarios(envelope.gherkinDocument)) {
      for (const step of scenario.steps) {
        const marker = lines[step.location.line - 1]?.match(/^\s*([-+*])\s/)?.[1];
        if (marker && marker !== "*") {
          errors.push(`${file.path}:${step.location.line}: Step bullets must use '*' (found '${marker}')`);
        }
      }
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

function assertionBindings(sourceFile: ts.SourceFile): {
  functions: Set<string>;
  namespaces: Set<string>;
  expectations: Set<string>;
} {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  const expectations = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (statement.moduleSpecifier.text.startsWith("node:assert")) {
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "strict") namespaces.add(element.name.text);
          else functions.add(element.name.text);
        }
      }
    }
    if (
      (statement.moduleSpecifier.text === "vitest" || statement.moduleSpecifier.text === "@jest/globals") &&
      clause?.namedBindings &&
      ts.isNamedImports(clause.namedBindings)
    ) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "expect") expectations.add(element.name.text);
      }
    }
  }
  return { functions, namespaces, expectations };
}

function isExpectationChain(expression: ts.Expression, expectations: Set<string>): boolean {
  if (ts.isCallExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expectations.has(expression.expression.text);
  }
  return ts.isPropertyAccessExpression(expression) && isExpectationChain(expression.expression, expectations);
}

function isAssertionCall(node: ts.CallExpression, bindings: ReturnType<typeof assertionBindings>): boolean {
  if (ts.isIdentifier(node.expression)) return bindings.functions.has(node.expression.text);
  if (ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression;
    if (ts.isIdentifier(owner) && bindings.namespaces.has(owner.text)) return true;
    return isExpectationChain(owner, bindings.expectations);
  }
  return false;
}

function directAssertions(
  root: ts.FunctionLikeDeclaration,
  bindings: ReturnType<typeof assertionBindings>,
): ts.CallExpression[] {
  const assertions: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && isAssertionCall(node, bindings)) assertions.push(node);
    ts.forEachChild(node, visit);
  };
  if (root.body) visit(root.body);
  return assertions;
}

type CucumberStepKind = "Given" | "When" | "Then" | "defineStep";

function cucumberStepBindings(sourceFile: ts.SourceFile): Map<string, CucumberStepKind> {
  const bindings = new Map<string, CucumberStepKind>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@cucumber/cucumber" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "Given" || imported === "When" || imported === "Then" || imported === "defineStep") {
        bindings.set(element.name.text, imported);
      }
    }
  }
  return bindings;
}

function checkStepDefinitions(file: SourceFile): string[] {
  const errors: string[] = [];
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = assertionBindings(sourceFile);
  const stepBindings = cucumberStepBindings(sourceFile);
  const assertionsInStepCallbacks = new Set<ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && stepBindings.has(node.expression.text)) {
      const kind = stepBindings.get(node.expression.text) as CucumberStepKind;
      const implementation = node.arguments.find(
        (argument) => ts.isFunctionExpression(argument) || ts.isArrowFunction(argument),
      );
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const assertions =
        implementation && ts.isFunctionLike(implementation) ? directAssertions(implementation, bindings) : [];
      for (const assertion of assertions) assertionsInStepCallbacks.add(assertion);
      if (kind === "defineStep") {
        errors.push(`${file.path}:${line}: defineStep is not allowed; use Given, When, or Then`);
      } else if (kind === "Then" && assertions.length !== 1) {
        errors.push(
          `${file.path}:${line}: Then step definition must contain exactly one direct assertion (found ${assertions.length})`,
        );
      } else if (kind !== "Then" && assertions.length !== 0) {
        errors.push(`${file.path}:${line}: ${kind} step definition must not contain assertions`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let assertionOutsideStepCallback = false;
  const findUnattributedAssertion = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isAssertionCall(node, bindings) &&
      !assertionsInStepCallbacks.has(node)
    ) {
      assertionOutsideStepCallback = true;
    }
    ts.forEachChild(node, findUnattributedAssertion);
  };
  findUnattributedAssertion(sourceFile);
  if (assertionOutsideStepCallback) {
    errors.push(`${file.path}: assertions are not allowed outside step definition callbacks`);
  }
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

function stringArray(expression: ts.Expression | undefined): string[] | undefined {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return undefined;
  const values: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    values.push(element.text);
  }
  return values;
}

function sameStrings(actual: string[] | undefined, expected: string[]): boolean {
  return Boolean(
    actual && actual.length === expected.length && actual.every((value, index) => value === expected[index]),
  );
}

function checkCucumberConfig(config: SourceFile): string[] {
  const errors: string[] = [];
  const sourceFile = ts.createSourceFile(config.path, config.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let profile: ts.ObjectLiteralExpression | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const assignment = statement.expression;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(assignment.right))
      continue;
    if (assignment.left.getText(sourceFile) !== "module.exports") continue;
    const candidate = objectProperty(assignment.right, "default");
    if (candidate && ts.isObjectLiteralExpression(candidate)) profile = candidate;
  }
  if (!profile) return [`${config.path}: a literal default Cucumber profile is required`];

  const language = objectProperty(profile, "language");
  if (!language || !ts.isStringLiteral(language) || language.text !== "ja") {
    errors.push(`${config.path}: Cucumber language must be explicitly set to 'ja'`);
  }
  if (objectProperty(profile, "strict")?.kind !== ts.SyntaxKind.TrueKeyword) {
    errors.push(`${config.path}: Cucumber strict mode must be explicitly enabled`);
  }
  if (objectProperty(profile, "dryRun")?.kind === ts.SyntaxKind.TrueKeyword) {
    errors.push(`${config.path}: Cucumber dry-run mode must not be enabled`);
  }
  const retry = objectProperty(profile, "retry");
  if (retry && (!ts.isNumericLiteral(retry) || retry.text !== "0")) {
    errors.push(`${config.path}: Cucumber retry must be omitted or explicitly set to 0`);
  }
  if (!sameStrings(stringArray(objectProperty(profile, "paths")), ["acceptance/features/**/*.feature.md"])) {
    errors.push(`${config.path}: Cucumber paths must target only acceptance/features/**/*.feature.md`);
  }
  if (!sameStrings(stringArray(objectProperty(profile, "requireModule")), ["tsx/cjs"])) {
    errors.push(`${config.path}: Cucumber must register tsx/cjs`);
  }
  if (
    !sameStrings(stringArray(objectProperty(profile, "require")), [
      "acceptance/steps/**/*.ts",
      "acceptance/support/**/*.ts",
    ])
  ) {
    errors.push(`${config.path}: Cucumber support code paths must target the TypeScript acceptance directories`);
  }
  return errors;
}

export function checkAcceptanceRules(input: AcceptanceSource): string[] {
  const errors = checkCucumberConfig(input.config);
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
