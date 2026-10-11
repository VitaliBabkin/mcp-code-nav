import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

// Structure budget only: hard limits of 150 lines per function and cognitive complexity 25.
// The 80-line soft budget is a review cue, not a gate. Scope is src/ and scripts/; tests are not measured.
export default [
  { ignores: ["dist/**", "dist-bundle/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { sonarjs },
    rules: {
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["error", 25],
    },
  },
];
