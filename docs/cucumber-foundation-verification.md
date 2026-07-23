# Cucumber foundation verification

This note records the negative source-map check required for the foundation PR. The temporary mutation described below was restored immediately after the command; it is not part of the committed acceptance test.

## TypeScript assertion failure and source map

On 2026-07-23, `acceptance/steps/project-check-safety.steps.ts` was temporarily changed from:

```ts
assert.equal(fs.existsSync(path.join(this.projectRoot, checkMarker)), false);
```

to:

```ts
assert.equal(fs.existsSync(path.join(this.projectRoot, checkMarker)), true);
```

Then this command was run from the repository root:

```bash
npm run test:acceptance
```

The command exited with status 1 and reported the assertion diff, the failing feature step, and the source-mapped TypeScript callback location:

```text
Failed scenarios:
  1) `.deadloop` に Git 管理ファイルがある場合は自動チェックを実行しない # acceptance/features/project-check-safety.feature.md:12
       ならばdeadloop は自動チェックを実行しない # acceptance/steps/project-check-safety.steps.ts:40
           AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

           false !== true

               + expected - actual

               -false
               +true

               at World.<anonymous> (.../acceptance/steps/project-check-safety.steps.ts:42:10)

1 scenario (1 failed)
5 steps (4 passed, 1 failed)
0m 0.18s (0m 0.10s executing your code)
```

After recording the output, the assertion was restored to require that the marker file does not exist. A clean successful acceptance run is part of the normal project verification.
