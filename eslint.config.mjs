import tsParser from "@typescript-eslint/parser";
import vitest from "@vitest/eslint-plugin";

// Biome remains the canonical formatter and general-purpose linter. ESLint
// supplies the focused Vitest rule that Biome does not provide.
export default [
  {
    files: ["**/*.{js,cjs,mjs}"],
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
    rules: {},
  },
  {
    files: ["test/**/*.test.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      vitest,
    },
    rules: {
      "vitest/max-expects": ["error", { max: 1 }],
    },
  },
];
