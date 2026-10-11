import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live-binary integration tests (`*.live.test.ts`) spawn real clangd/clang-query and are
    // excluded from the default run — see `npm run test:live` and the "Tests" section of
    // WORKFLOW.md. Everything else here is vitest's own default exclude list, restated because
    // setting `exclude` at all replaces it rather than extending it.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      // A fixture is data a live test reads, never a suite. The TS workspace fixture keeps a
      // `test/store.test.ts` precisely because that is the shape a tsconfig `include` leaves out, and the
      // pattern below would otherwise collect it as one.
      "**/fixtures/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/*.live.test.ts",
    ],
  },
});
