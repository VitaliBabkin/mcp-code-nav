# AGENTS.md

`mcp-code-nav` is a stdio MCP server that gives coding agents compiler-grade navigation (outlines, declarations,
references, callers, implementations) for C++ (clangd, clang-query), Go (gopls) and TypeScript (the TypeScript 7 native
server, tsgo). TypeScript, ESM, strict mode, Node 20+.

The rules live in [PRINCIPLES.md](docs/PRINCIPLES.md) (what a change must keep) and
[WORKFLOW.md](docs/WORKFLOW.md) (how to get it merged, the gate list, the live suite, how to report problems). Read
PRINCIPLES.md before changing behaviour under `src/`; a rename or a typo fix does not need it.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the structure and the module layout.

Orientation: one file per tool in `src/tools/`, named `<lang>-<question>.ts`; tests mirror `src/` under `test/`;
`*.live.test.ts` files need real language servers.

## Checks

Before reporting a code change done, run `npm run lint`, `npm run typecheck` and `npm test`; a docs-only change needs
none. One test file: `npm test -- test/tools/input-limits.test.ts`. When you change behaviour that depends on clangd,
clang-query, gopls or tsgo, also run `npm run test:live`; a file whose tool is not installed skips, so say which files
skipped instead of reporting them as passed. The other scripts are in `package.json`; the gate list and the live-suite
setup are in WORKFLOW.md.

## Conventions

- No `any` and no `@ts-ignore` without a one-line reason, in `src/`, `scripts/` and `test/` alike. Node built-ins use
  the `node:` prefix; relative imports end in `.js`.
- stdout belongs to the MCP protocol: never print to it. Diagnostics go to stderr.
- Every tool input goes through a zod schema (limits in `src/tools/input-limits.ts`); paths are checked against the
  declared roots before use; processes are spawned with argv arrays, never a shell.
- Execution failures are `isError: true` results with a stated cause (`src/mcp-response.ts`), not thrown protocol
  errors.
- An empty result is returned as an answer only when readiness is proven; a cold or unindexed input is an error. Every
  answer states its extent in `scope`.
- Functions you write or touch aim under 80 lines; lint fails at 150. Comments explain a non-obvious why, not what the
  code says.
- New code ships tests; a bug fix ships a regression test that fails first. Behaviour that depends on a real binary
  needs a `*.live.test.ts` case and a fixture, not only a mock.
- A change to a tool, response shape, config file or environment variable updates the README in the same change.
- Keep the change to what the task asks. When the requested work is done and the checks pass, stop and report; mention
  unrelated bugs or cleanups at the end instead of fixing them. If the task is ambiguous, or a rule here or in
  PRINCIPLES.md would have to bend, stop and ask instead of choosing silently.

## Boundaries

- Do not write to the analysed sources, add an index of this server's own, or widen what a session may send to a
  language server (`allowedRequests` in `src/lsp/server-config.ts`): the server is a read-only observer of the user's
  code, and a temp file in their tree breaks that trust as much as an edit does. `cpp_find_derived_classes` never uses a
  single-level LSP call, because it provably misses grandchildren.
- Change dependencies with `npm install` / `npm uninstall` so the lockfile is regenerated (never edit
  `package-lock.json` by hand), and state why in the pull request. Build outputs (`dist/`, `dist-bundle/`) are
  git-ignored.
- Do not weaken, skip or delete a failing test to get green: the failure is information about the code.
- Do not add references to private documents, review rounds or locations outside this repository;
  `test/no-internal-references.test.ts` fails on them.
- Commit only when the user asks you to, and push only on their explicit request: the contributor owns their history.
  Otherwise leave changes uncommitted in the working tree. Contributors follow the pull request flow in WORKFLOW.md;
  commit message format is there too.
