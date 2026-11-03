import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

// typescript-eslint strictTypeChecked beside the structure budget: hard limits of 150 lines per function
// and cognitive complexity 25. The 80-line soft budget is a review cue, not a gate. Scope is src/ and
// scripts/; tests are not linted. Existing debt is recorded in eslint-suppressions.json and only shrinks.
export default tseslint.config(
  { ignores: ["dist/**", "dist-bundle/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.scripts.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs },
    rules: {
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["error", 25],
    },
  },
);
