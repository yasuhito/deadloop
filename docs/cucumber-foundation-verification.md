# Cucumber foundation verification

This note records the negative source-map check required for the foundation PR. The temporary mutation described below was restored immediately after the command; it is not part of the committed acceptance test.

## TypeScript assertion failure and source map

On 2026-07-15, `acceptance/steps/project-check-safety.steps.ts` was temporarily changed from:

```ts
assert.equal(this.resultCode, 1);
```

to:

```ts
assert.equal(this.resultCode, 0);
```

Then this command was run from the repository root:

```bash
npm run test:acceptance
```

The command exited with status 1 and reported the assertion diff, the failing feature step, and the source-mapped TypeScript callback location:

```text
Failed scenarios:
  1) 作業用一時ディレクトリに Git 管理ファイルがある # acceptance/features/project-check-safety.feature.md:9
       ならばdeadloop は自動チェックを実行しない # acceptance/steps/project-check-safety.steps.ts:35
           AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

           1 !== 0

               + expected - actual

               -1
               +0

               at World.<anonymous> (.../acceptance/steps/project-check-safety.steps.ts:36:10)

1 scenario (1 failed)
4 steps (3 passed, 1 failed)
0m 0.17s (0m 0.9s executing your code)
```

After recording the output, the assertion was restored to `assert.equal(this.resultCode, 1);`. A clean successful acceptance run is part of the normal project verification.
