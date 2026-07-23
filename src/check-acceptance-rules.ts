import fs from "node:fs";
import path from "node:path";

import { CucumberExpression, ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType, type GherkinDocument, type Scenario, type Step } from "@cucumber/messages";
import ts from "typescript";

export type SourceFile = { path: string; source: string };
export type AcceptanceSource = {
  config: SourceFile;
  features: SourceFile[];
  stepDefinitions: SourceFile[];
  helpers: SourceFile[];
};

type EffectiveScenario = { scenario: Scenario; steps: Step[] };

function scenarios(document: GherkinDocument): EffectiveScenario[] {
  const found: EffectiveScenario[] = [];
  const featureChildren = document.feature?.children ?? [];
  const featureBackground = featureChildren.find((child) => child.background)?.background?.steps ?? [];
  for (const child of featureChildren) {
    if (child.scenario) found.push({ scenario: child.scenario, steps: [...featureBackground, ...child.scenario.steps] });
    if (!child.rule) continue;
    const ruleBackground = child.rule.children.find((ruleChild) => ruleChild.background)?.background?.steps ?? [];
    for (const ruleChild of child.rule.children) {
      if (ruleChild.scenario) {
        found.push({
          scenario: ruleChild.scenario,
          steps: [...featureBackground, ...ruleBackground, ...ruleChild.scenario.steps],
        });
      }
    }
  }
  return found;
}

function checkFeature(file: SourceFile): string[] {
  const errors: string[] = [];
  const lines = file.source.split(/\r?\n/);
  if (/^(?:---|\+\+\+)(?:\r?\n|$)/.test(file.source)) errors.push(`${file.path}: front matter is not allowed`);
  for (const [index, line] of lines.entries()) {
    if (/^\s*#\s*language\s*:/.test(line)) {
      errors.push(`${file.path}:${index + 1}: language directives are not allowed`);
    }
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
    for (const { scenario, steps } of scenarios(envelope.gherkinDocument)) {
      for (const step of steps) {
        const marker = lines[step.location.line - 1]?.match(/^\s*([-+*])\s/)?.[1];
        if (marker && marker !== "*") {
          errors.push(`${file.path}:${step.location.line}: Step bullets must use '*' (found '${marker}')`);
        }
      }
      const resultCount = steps.filter((step) => step.keywordType === "Outcome").length;
      if (resultCount !== 1) {
        errors.push(
          `${file.path}:${scenario.location.line}: scenario must contain exactly one result step (found ${resultCount})`,
        );
      }
      let resultSeen = false;
      for (const step of steps) {
        if (step.keywordType === "Outcome") resultSeen = true;
        else if (resultSeen && step.keywordType === "Conjunction") {
          errors.push(`${file.path}:${step.location.line}: And/But after Then is not allowed`);
        }
      }
    }
  }
  return errors;
}

function requiredModule(expression: ts.Expression | undefined): string | undefined {
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "require" ||
    expression.arguments.length !== 1 ||
    !ts.isStringLiteral(expression.arguments[0])
  ) {
    return undefined;
  }
  return expression.arguments[0].text;
}

function isNodeAssertModule(module: string): boolean {
  return module === "assert" || module === "assert/strict" || module === "node:assert" || module === "node:assert/strict";
}

type AliasTarget = ts.BindingName | ts.ObjectLiteralExpression;

function assertionAliasAssignments(
  sourceFile: ts.SourceFile,
): Array<{ name: AliasTarget; initializer: ts.Expression }> {
  const assignments: Array<{ name: AliasTarget; initializer: ts.Expression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      assignments.push({ name: node.name, initializer: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isIdentifier(node.left) || ts.isObjectLiteralExpression(node.left))
    ) {
      assignments.push({ name: node.left, initializer: node.right });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assignments;
}

function unparenthesized(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function accessedProperty(expression: ts.Expression): { owner: string; property: string } | undefined {
  const normalized = unparenthesized(expression);
  if (ts.isPropertyAccessExpression(normalized)) {
    const owner = unparenthesized(normalized.expression);
    if (ts.isIdentifier(owner)) return { owner: owner.text, property: normalized.name.text };
  }
  if (ts.isElementAccessExpression(normalized) && normalized.argumentExpression) {
    const owner = unparenthesized(normalized.expression);
    if (ts.isIdentifier(owner) && ts.isStringLiteral(normalized.argumentExpression)) {
      return { owner: owner.text, property: normalized.argumentExpression.text };
    }
  }
  return undefined;
}

function destructuredAliases(
  target: AliasTarget,
  sourceFile: ts.SourceFile,
): Array<{ local: string; property: string }> | undefined {
  if (ts.isObjectBindingPattern(target)) {
    return target.elements.flatMap((element) =>
      ts.isIdentifier(element.name)
        ? [{ local: element.name.text, property: element.propertyName?.getText(sourceFile) ?? element.name.text }]
        : [],
    );
  }
  if (!ts.isObjectLiteralExpression(target)) return undefined;
  return target.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return [{ local: property.name.text, property: property.name.text }];
    }
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      ts.isIdentifier(property.initializer)
    ) {
      return [{ local: property.initializer.text, property: property.name.text }];
    }
    return [];
  });
}

function localSymbol(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(node);
}

function assertionBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker): {
  functions: Set<ts.Symbol>;
  namespaces: Set<ts.Symbol>;
  expectations: Set<ts.Symbol>;
  checker: ts.TypeChecker;
} {
  const functions = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const expectations = new Set<ts.Symbol>();
  const add = (bindings: Set<ts.Symbol>, identifier: ts.Identifier): void => {
    const symbol = localSymbol(checker, identifier);
    if (symbol) bindings.add(symbol);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const module = requiredModule(declaration.initializer);
        if (!module || !isNodeAssertModule(module)) continue;
        if (ts.isIdentifier(declaration.name)) add(namespaces, declaration.name);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = element.propertyName?.getText(sourceFile) ?? element.name.text;
            add(imported === "strict" ? namespaces : functions, element.name);
          }
        }
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (isNodeAssertModule(statement.moduleSpecifier.text)) {
      if (clause?.name) add(namespaces, clause.name);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(namespaces, clause.namedBindings.name);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          add(imported === "strict" ? namespaces : functions, element.name);
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
        if (imported === "expect") add(expectations, element.name);
      }
    }
  }

  const symbolForAlias = (target: AliasTarget, local: string): ts.Symbol | undefined => {
    if (ts.isIdentifier(target)) return localSymbol(checker, target);
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === local) {
          return checker.getShorthandAssignmentValueSymbol(property);
        }
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.initializer) &&
          property.initializer.text === local
        ) return localSymbol(checker, property.initializer);
      }
    }
    let found: ts.Symbol | undefined;
    const visit = (node: ts.Node): void => {
      if (!found && ts.isIdentifier(node) && node.text === local) found = localSymbol(checker, node);
      if (!found) ts.forEachChild(node, visit);
    };
    visit(target);
    return found;
  };
  const ownerSymbol = (expression: ts.Expression): ts.Symbol | undefined => {
    const access = unparenthesized(expression);
    const owner = ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)
      ? unparenthesized(access.expression)
      : undefined;
    return owner && ts.isIdentifier(owner) ? localSymbol(checker, owner) : undefined;
  };

  const aliases = assertionAliasAssignments(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      const initializer = unparenthesized(alias.initializer);
      const destructured = destructuredAliases(alias.name, sourceFile);
      const initializerSymbol = ts.isIdentifier(initializer) ? localSymbol(checker, initializer) : undefined;
      const initializerModule = requiredModule(initializer);
      if (
        destructured &&
        ((initializerModule && isNodeAssertModule(initializerModule)) ||
          (initializerSymbol && namespaces.has(initializerSymbol)))
      ) {
        for (const element of destructured) {
          const symbol = symbolForAlias(alias.name, element.local);
          const target = element.property === "strict" ? namespaces : functions;
          if (symbol && !target.has(symbol)) {
            target.add(symbol);
            changed = true;
          }
        }
        continue;
      }
      if (!ts.isIdentifier(alias.name)) continue;
      const local = localSymbol(checker, alias.name);
      if (!local) continue;
      if (initializerModule && isNodeAssertModule(initializerModule) && !namespaces.has(local)) {
        namespaces.add(local);
        changed = true;
        continue;
      }
      if (initializerSymbol) {
        for (const bindings of [functions, namespaces, expectations]) {
          if (bindings.has(initializerSymbol) && !bindings.has(local)) {
            bindings.add(local);
            changed = true;
          }
        }
        continue;
      }
      const access = accessedProperty(initializer);
      const accessOwner = ownerSymbol(initializer);
      if (access && accessOwner && namespaces.has(accessOwner)) {
        const target = access.property === "strict" ? namespaces : functions;
        if (!target.has(local)) {
          target.add(local);
          changed = true;
        }
        continue;
      }
      if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === "bind"
      ) {
        const bound = unparenthesized(initializer.expression.expression);
        const boundAccess = accessedProperty(bound);
        const boundSymbol = ts.isIdentifier(bound) ? localSymbol(checker, bound) : undefined;
        const boundOwner = ownerSymbol(bound);
        const isBoundAssertion =
          Boolean(boundSymbol && functions.has(boundSymbol)) ||
          Boolean(boundAccess && boundOwner && namespaces.has(boundOwner) && boundAccess.property !== "strict");
        if (isBoundAssertion && !functions.has(local)) {
          functions.add(local);
          changed = true;
        }
      }
    }
  }
  return { functions, namespaces, expectations, checker };
}

function isExpectationChain(expression: ts.Expression, bindings: ReturnType<typeof assertionBindings>): boolean {
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    const symbol = ts.isIdentifier(callee) ? localSymbol(bindings.checker, callee) : undefined;
    return Boolean(symbol && bindings.expectations.has(symbol));
  }
  return ts.isPropertyAccessExpression(expression) && isExpectationChain(expression.expression, bindings);
}

function isAssertionFunction(
  expression: ts.Expression,
  bindings: ReturnType<typeof assertionBindings>,
): boolean {
  const normalized = unparenthesized(expression);
  if (ts.isIdentifier(normalized)) {
    const symbol = localSymbol(bindings.checker, normalized);
    return Boolean(symbol && bindings.functions.has(symbol));
  }
  const access = accessedProperty(normalized);
  const owner = ts.isPropertyAccessExpression(normalized) || ts.isElementAccessExpression(normalized)
    ? unparenthesized(normalized.expression)
    : undefined;
  const symbol = owner && ts.isIdentifier(owner) ? localSymbol(bindings.checker, owner) : undefined;
  if (access && symbol && bindings.namespaces.has(symbol)) return access.property !== "strict";
  if (ts.isPropertyAccessExpression(normalized)) {
    const directModule = requiredModule(unparenthesized(normalized.expression));
    return Boolean(directModule && isNodeAssertModule(directModule));
  }
  return false;
}

function isAssertionCall(node: ts.CallExpression, bindings: ReturnType<typeof assertionBindings>): boolean {
  const expression = unparenthesized(node.expression);
  if (
    ts.isPropertyAccessExpression(expression) &&
    (() => {
      const owner = unparenthesized(expression.expression);
      return ts.isIdentifier(owner) && owner.text === "Reflect";
    })() &&
    expression.name.text === "apply" &&
    node.arguments[0] &&
    isAssertionFunction(node.arguments[0], bindings)
  ) {
    return true;
  }
  if (isAssertionFunction(expression, bindings)) return true;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = unparenthesized(expression.expression);
    if ((expression.name.text === "call" || expression.name.text === "apply") && isAssertionFunction(owner, bindings)) {
      return true;
    }
    return isExpectationChain(owner, bindings);
  }
  if (ts.isElementAccessExpression(expression)) {
    const owner = unparenthesized(expression.expression);
    const directModule = requiredModule(owner);
    const symbol = ts.isIdentifier(owner) ? localSymbol(bindings.checker, owner) : undefined;
    return Boolean((directModule && isNodeAssertModule(directModule)) || (symbol && bindings.namespaces.has(symbol)));
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

type CucumberStepBindings = {
  functions: Map<string, CucumberStepKind>;
  namespaces: Set<string>;
  indirectFunctions: Map<string, CucumberStepKind>;
};

function cucumberStepBindings(sourceFile: ts.SourceFile): CucumberStepBindings {
  const functions = new Map<string, CucumberStepKind>();
  const namespaces = new Set<string>();
  const indirectFunctions = new Map<string, CucumberStepKind>();
  const add = (local: string, imported: string): void => {
    if (imported === "Given" || imported === "When" || imported === "Then" || imported === "defineStep") {
      functions.set(local, imported);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (requiredModule(declaration.initializer) !== "@cucumber/cucumber") continue;
        if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            add(element.name.text, element.propertyName?.getText(sourceFile) ?? element.name.text);
          }
        }
      }
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@cucumber/cucumber" ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) {
      add(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }

  const aliases = assertionAliasAssignments(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      const initializer = unparenthesized(alias.initializer);
      const destructured = destructuredAliases(alias.name, sourceFile);
      if (destructured && ts.isIdentifier(initializer) && namespaces.has(initializer.text)) {
        for (const element of destructured) {
          if (functions.has(element.local)) continue;
          add(element.local, element.property);
          if (functions.has(element.local)) changed = true;
        }
        continue;
      }
      if (!ts.isIdentifier(alias.name)) continue;
      const local = alias.name.text;
      const indirectKind = indirectCucumberStepKindForExpression(initializer, {
        functions,
        namespaces,
        indirectFunctions,
      });
      if (indirectKind) {
        if (!indirectFunctions.has(local)) {
          indirectFunctions.set(local, indirectKind);
          changed = true;
        }
        continue;
      }
      if (ts.isIdentifier(initializer)) {
        const kind = functions.get(initializer.text);
        if (kind && !functions.has(local)) {
          functions.set(local, kind);
          changed = true;
        }
        if (namespaces.has(initializer.text) && !namespaces.has(local)) {
          namespaces.add(local);
          changed = true;
        }
        continue;
      }
      if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === "bind" &&
        !functions.has(local)
      ) {
        const bound = unparenthesized(initializer.expression.expression);
        const boundAccess = accessedProperty(bound);
        const kind = ts.isIdentifier(bound)
          ? functions.get(bound.text)
          : boundAccess &&
              namespaces.has(boundAccess.owner) &&
              (boundAccess.property === "Given" ||
                boundAccess.property === "When" ||
                boundAccess.property === "Then" ||
                boundAccess.property === "defineStep")
            ? boundAccess.property
            : undefined;
        if (kind) {
          functions.set(local, kind);
          changed = true;
        }
        continue;
      }
      const access = accessedProperty(initializer);
      if (!access || !namespaces.has(access.owner) || functions.has(local)) continue;
      add(local, access.property);
      if (functions.has(local)) changed = true;
    }
  }
  return { functions, namespaces, indirectFunctions };
}

function cucumberStepKind(expression: ts.Expression, bindings: CucumberStepBindings): CucumberStepKind | undefined {
  const normalized = unparenthesized(expression);
  if (ts.isIdentifier(normalized)) return bindings.functions.get(normalized.text);
  if (ts.isPropertyAccessExpression(normalized)) {
    const owner = unparenthesized(normalized.expression);
    const isCucumberNamespace =
      requiredModule(owner) === "@cucumber/cucumber" ||
      (ts.isIdentifier(owner) && bindings.namespaces.has(owner.text));
    const name = normalized.name.text;
    if (
      isCucumberNamespace &&
      (name === "Given" || name === "When" || name === "Then" || name === "defineStep")
    ) {
      return name;
    }
  }
  if (ts.isElementAccessExpression(normalized) && normalized.argumentExpression) {
    const owner = unparenthesized(normalized.expression);
    const name = ts.isStringLiteral(normalized.argumentExpression) ? normalized.argumentExpression.text : undefined;
    const isCucumberNamespace =
      requiredModule(owner) === "@cucumber/cucumber" ||
      (ts.isIdentifier(owner) && bindings.namespaces.has(owner.text));
    if (
      isCucumberNamespace &&
      (name === "Given" || name === "When" || name === "Then" || name === "defineStep")
    ) {
      return name;
    }
  }
  return undefined;
}

type EffectiveStepKind = Exclude<CucumberStepKind, "defineStep">;

type StepKindsByText = Map<string, Set<EffectiveStepKind>>;

const cucumberParameterTypes = new ParameterTypeRegistry();

function featureStepKinds(files: SourceFile[]): StepKindsByText {
  const kindsByText: StepKindsByText = new Map();
  for (const file of files) {
    const envelopes = generateMessages(
      file.source,
      file.path,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_MARKDOWN,
      {
        defaultDialect: "ja",
        includeGherkinDocument: true,
        includePickles: false,
        includeSource: false,
        newId: IdGenerator.incrementing(),
      },
    );
    for (const envelope of envelopes) {
      if (!envelope.gherkinDocument) continue;
      for (const { steps } of scenarios(envelope.gherkinDocument)) {
        let previousKind: EffectiveStepKind | undefined;
        for (const step of steps) {
          const kind: EffectiveStepKind | undefined =
            step.keywordType === "Context"
              ? "Given"
              : step.keywordType === "Action"
                ? "When"
                : step.keywordType === "Outcome"
                  ? "Then"
                  : step.keywordType === "Conjunction"
                    ? previousKind
                    : undefined;
          if (!kind) continue;
          previousKind = kind;
          const kinds = kindsByText.get(step.text) ?? new Set<EffectiveStepKind>();
          kinds.add(kind);
          kindsByText.set(step.text, kinds);
        }
      }
    }
  }
  return kindsByText;
}

function matchedStepKinds(
  expression: ts.Expression | undefined,
  kindsByText: StepKindsByText,
): Set<EffectiveStepKind> | undefined {
  if (!expression) return undefined;
  const normalized = unparenthesized(expression);
  if (ts.isStringLiteral(normalized) || ts.isNoSubstitutionTemplateLiteral(normalized)) {
    let pattern: CucumberExpression;
    try {
      pattern = new CucumberExpression(normalized.text, cucumberParameterTypes);
    } catch {
      return new Set();
    }
    const kinds = new Set<EffectiveStepKind>();
    for (const [text, textKinds] of kindsByText) {
      if (pattern.match(text)) for (const kind of textKinds) kinds.add(kind);
    }
    return kinds;
  }
  if (!ts.isRegularExpressionLiteral(normalized)) return undefined;
  const match = normalized.text.match(/^\/(.*)\/([a-z]*)$/s);
  if (!match) return undefined;
  let pattern: RegExp;
  try {
    pattern = new RegExp(match[1], match[2]);
  } catch {
    return undefined;
  }
  const kinds = new Set<EffectiveStepKind>();
  for (const [text, textKinds] of kindsByText) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) for (const kind of textKinds) kinds.add(kind);
  }
  return kinds;
}

function sourceProgram(file: SourceFile): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const baseHost = ts.createCompilerHost({ noResolve: true });
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (name) => name === file.path,
    readFile: (name) => (name === file.path ? file.source : undefined),
    getSourceFile: (name) => (name === file.path ? sourceFile : undefined),
  };
  const program = ts.createProgram({ rootNames: [file.path], options: { noResolve: true }, host });
  return { sourceFile: program.getSourceFile(file.path) ?? sourceFile, checker: program.getTypeChecker() };
}

function indirectCucumberStepKindForExpression(
  expression: ts.Expression,
  bindings: CucumberStepBindings,
): CucumberStepKind | undefined {
  const normalized = unparenthesized(expression);
  if (ts.isIdentifier(normalized)) return bindings.indirectFunctions.get(normalized.text);
  if (ts.isPropertyAccessExpression(normalized)) {
    if (normalized.name.text !== "call" && normalized.name.text !== "apply") return undefined;
    return cucumberStepKind(normalized.expression, bindings);
  }
  if (
    ts.isCallExpression(normalized) &&
    ts.isPropertyAccessExpression(normalized.expression) &&
    normalized.expression.name.text === "bind"
  ) {
    return indirectCucumberStepKindForExpression(normalized.expression.expression, bindings);
  }
  return undefined;
}

function indirectCucumberStepKind(node: ts.CallExpression, bindings: CucumberStepBindings): CucumberStepKind | undefined {
  const fromCallee = indirectCucumberStepKindForExpression(node.expression, bindings);
  if (fromCallee) return fromCallee;
  const expression = unparenthesized(node.expression);
  if (
    !ts.isPropertyAccessExpression(expression) ||
    (() => {
      const owner = unparenthesized(expression.expression);
      return !ts.isIdentifier(owner) || owner.text !== "Reflect";
    })() ||
    expression.name.text !== "apply" ||
    !node.arguments[0]
  ) {
    return undefined;
  }
  return cucumberStepKind(node.arguments[0], bindings);
}

function checkStepDefinitions(
  file: SourceFile,
  unattributedAssertionMessage = "assertions are not allowed outside step definition callbacks",
  kindsByText: StepKindsByText = new Map(),
): string[] {
  const errors: string[] = [];
  const { sourceFile, checker } = sourceProgram(file);
  const bindings = assertionBindings(sourceFile, checker);
  const stepBindings = cucumberStepBindings(sourceFile);
  const assertionsInStepCallbacks = new Set<ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = cucumberStepKind(node.expression, stepBindings);
      if (!kind) {
        const indirectKind = indirectCucumberStepKind(node, stepBindings);
        if (indirectKind) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          errors.push(`${file.path}:${line}: indirect Cucumber ${indirectKind} registration is not allowed`);
        }
        ts.forEachChild(node, visit);
        return;
      }
      const implementation = node.arguments.find(
        (argument) => ts.isFunctionExpression(argument) || ts.isArrowFunction(argument),
      );
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const assertions =
        implementation && ts.isFunctionLike(implementation) ? directAssertions(implementation, bindings) : [];
      for (const assertion of assertions) assertionsInStepCallbacks.add(assertion);
      const matchedKinds = matchedStepKinds(node.arguments[0], kindsByText);
      if (kind === "defineStep") {
        errors.push(`${file.path}:${line}: defineStep is not allowed; use Given, When, or Then`);
      } else if (!matchedKinds) {
        errors.push(`${file.path}:${line}: step definition pattern must be a string or regular expression literal`);
      } else if (matchedKinds.size > 1) {
        errors.push(`${file.path}:${line}: step definition matches multiple Gherkin step kinds`);
      } else if (matchedKinds.size === 1 && !matchedKinds.has(kind)) {
        errors.push(
          `${file.path}:${line}: step definition registered with ${kind} matches a ${[...matchedKinds][0]} step`,
        );
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
  if (assertionOutsideStepCallback) errors.push(`${file.path}: ${unattributedAssertionMessage}`);
  return errors;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = [...object.properties].reverse().find(
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

function hasOnlyStaticProperties(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
  );
}

function checkCucumberConfig(config: SourceFile): string[] {
  const errors: string[] = [];
  const sourceFile = ts.createSourceFile(config.path, config.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let profile: ts.ObjectLiteralExpression | undefined;
  const meaningfulStatements = sourceFile.statements.filter(
    (statement) => !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)),
  );
  const statement = meaningfulStatements.at(-1);
  if (statement && ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
    const assignment = statement.expression;
    if (
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.left.getText(sourceFile) === "module.exports" &&
      ts.isObjectLiteralExpression(assignment.right) &&
      hasOnlyStaticProperties(assignment.right)
    ) {
      const candidate = objectProperty(assignment.right, "default");
      if (candidate && ts.isObjectLiteralExpression(candidate) && hasOnlyStaticProperties(candidate)) {
        profile = candidate;
      }
    }
  }
  if (!profile) return [`${config.path}: a literal default Cucumber profile is required`];

  const allowedProperties = new Set(["paths", "requireModule", "require", "language", "strict", "format", "dryRun", "retry"]);
  for (const property of profile.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (name && !allowedProperties.has(name)) {
      errors.push(`${config.path}: Cucumber default profile property '${name}' is not allowed`);
    }
  }

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
  const kindsByText = featureStepKinds(input.features);
  for (const feature of input.features) errors.push(...checkFeature(feature));
  for (const steps of input.stepDefinitions) errors.push(...checkStepDefinitions(steps, undefined, kindsByText));
  for (const helper of input.helpers) {
    errors.push(...checkStepDefinitions(helper, "assertions are not allowed in acceptance helpers", kindsByText));
  }
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
