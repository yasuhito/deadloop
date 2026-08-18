# Host-portable module format

## Problem

deadloop's runtime modules are CommonJS TypeScript: a `.ts` file assigns `module.exports`, and callers read it with `require("....ts")`. Node loads these with type stripping only, which is what lets `extensions/deadloop/automations/launch-agent.cts` and the other driver scripts run under bare `node` with no build step (see [ADR 0004](adr/0004-agent-launcher.md)).

The pi host resolves those files as CommonJS. The omp (Oh My Pi) host does not. Its extension loader (`src/extensibility/plugins/legacy-pi-compat.ts`, `isCommonJsModulePath`) only classifies `.cjs`, `.cts`, and `type: commonjs` `.js`/`.jsx` as CommonJS; every other TypeScript file in the module graph is loaded as ESM. Two failure modes follow:

- a `.ts` file that also has a top-level `export` throws `ReferenceError: module is not defined` when it reaches `module.exports`, and the whole extension fails to load;
- a `.ts` file with no top-level `export` loads, but `require("....ts")` returns an empty namespace, so callers see `undefined` where a function should be.

Minimal reproduction — one ESM entry requiring the same CommonJS body twice, once as `.ts` and once as `.cts`:

```text
omp: ts keys: []            cts keys: [ "hello" ]
pi : ts keys: [ "hello" ]   cts keys: [ "hello" ]
```

Observed in the product, before the rename: `/deadloop-status` under omp first failed to load the extension (`module is not defined` in the module now named `src/monitor-prompts.cts`), then, once the hybrid modules were fixed, failed with `normalizeEnablementStateValue is not a function` because requiring the module now named `src/enablement-state.cts` under its old `.ts` name returned nothing.

This blocks the project direction recorded in `AGENTS.md`: deadloop should not be tied to one execution host. Today the package silently depends on pi's loader implementation.

## Goals

- One package that loads and drives automations under both the pi host and the omp host, with no host-specific branch in deadloop.
- The bare-`node` driver launch path keeps working with type stripping only, with no build step.
- Module format is declared by file extension, so host loaders do not have to guess.
- A deterministic test prevents the broken format from coming back.

## Non-goals

- Do not convert the runtime graph to ESM. The driver scripts must stay requireable under bare `node` in a `type: commonjs` package.
- Do not change Herdr as the execution runner.
- Do not keep compatibility shims: no dual filenames, no loader-specific branches, no acceptance of the old `.ts` driver names in configuration.
- Do not add omp as a worker/reviewer agent kind. That is separate work in `src/agent-profiles.cjs`.

## Proposed shape

Declare CommonJS by extension: every runtime module that assigns `module.exports` becomes `.cts`, and every `require()` specifier that names it is updated. ESM modules (`src/core.ts`, `src/automation-runner.ts`, and the rest that export values with `export`) stay `.ts`. The extension entry `extensions/deadloop/index.ts` stays ESM; only its required graph changes.

`.cts` is host-neutral, which is why it is the target form rather than a loader-specific workaround. Verified before committing to this shape:

| Loader | `.cts` with `module.exports` |
|---|---|
| `node` v26.7.0, type stripping only | requires successfully |
| `tsx` | requires successfully |
| `vitest` | requires successfully |
| pi extension loader | requires successfully |
| omp extension loader (Bun) | requires successfully |

Counted scope: 18 CommonJS modules under `src/`, 36 under `extensions/deadloop/automations/`, referenced from `require()` specifiers spread across roughly 100 files, plus manifest globs, `projects.json` `driverFile` / `precheckFile` values, and docs.

## Rollout plan

0. Remove the hybrid form (top-level `export` plus `module.exports`) and add a guard test. Done: type-only declarations moved to `src/automation-driver-kit-types.ts`, `src/attempt-runtime-observation-types.ts`, and `src/reviewer-outcome-contract-types.ts`, following the existing types-only module `src/runner.ts`; `test/module-format-portability.test.ts` forbids the hybrid form.
1. Rename the 18 `src/` CommonJS modules to `.cts` and update every specifier.
2. Rename the 36 automation CommonJS modules to `.cts`, including the driver paths that are built as strings and therefore invisible to the type checker.
3. Update `package.json` `files` and lint globs, `tsconfig.json`, `projects.example.json` driver/precheck names, and the docs that name these files. Record the one-line migration note for existing local `projects.json` files.
4. Accept the result on both hosts and harden the guard to forbid `module.exports` in any `.ts`.

## Acceptance criteria

- No `.ts` file under `src/` or `extensions/deadloop/` assigns `module.exports`, enforced by `test/module-format-portability.test.ts`.
- No stale `require("....ts")` specifier or driver path string remains.
- `omp -p -e extensions/deadloop/index.ts "/deadloop-status"` reports status with no extension load warning, and an interactive omp session starts the scheduler and records ticks in `state.json`.
- The same three checks (status, doctor, scheduler) still pass under the pi host, and a project driven by one host is not driven by the other at the same time (scheduler lock).
- A driver still runs under bare `node` against a fixture and returns its JSON result.
- `npm test`, `npm run lint`, `npm run typecheck`, `bash -n extensions/deadloop/automations/*.sh`, and `npm pack --dry-run` all pass.

## Implementation issues

The GitHub issues created from this PRD are intentionally not labeled `agent:implement`. Add that label when a human is ready to let deadloop pick up a specific slice. Slices are ordered; slice 4 requires 1 through 3.

- [#350](https://github.com/yasuhito/deadloop/issues/350) Move src CommonJS TypeScript modules to .cts
- [#351](https://github.com/yasuhito/deadloop/issues/351) Move automation CommonJS TypeScript modules to .cts
- [#352](https://github.com/yasuhito/deadloop/issues/352) Update manifests, globs, config, and docs for .cts modules
- [#353](https://github.com/yasuhito/deadloop/issues/353) Accept deadloop on both pi and omp hosts and harden the module-format guard
