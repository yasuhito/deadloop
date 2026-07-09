// Compatibility shim for generic JavaScript lint runners.
//
// deadloop uses Biome as the canonical formatter/linter; see `npm run lint`.
// Some agent/test harnesses auto-detect JavaScript projects and invoke ESLint
// directly. Keep ESLint from failing with "couldn't find eslint.config" while
// avoiding a second, divergent lint rule set.
export default [
  {
    files: ["**/*.{js,cjs,mjs}"],
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
    rules: {},
  },
];
