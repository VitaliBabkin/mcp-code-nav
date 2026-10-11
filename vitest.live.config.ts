import { defineConfig } from "vitest/config";

/**
 * Separate config for the live-binary integration suite (`*.live.test.ts`) — spawns the real
 * `clangd`/`clang-query` binaries, excluded from the default `npm test` run (see `vitest.config.ts`
 * and the "Tests" section of WORKFLOW.md). Run explicitly via `npm run test:live`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    // States which real tools were found, and fails the run when `MCP_CODE_NAV_LIVE_REQUIRE` names one that is not.
    globalSetup: ["test/live-setup.ts"],
    /**
     * One test file at a time. Every file in this suite starts a real language server and cleans a temp
     * directory beside it, and Windows releases a killed process's handles on its own schedule: with the
     * default concurrency (one file per spare core) a server shutting down in one file lands while another
     * file is spawning servers, and the cleanup that loses that race reports `could not remove` rather than a
     * wrong answer. Serialising the files removes the race instead of out-waiting it — no deletion here gets a
     * longer retry budget or a quieter failure. The worker cap is pool-independent, so it holds for any `pool`.
     */
    maxWorkers: 1,
    fileParallelism: false,
  },
});
