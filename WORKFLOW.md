# Workflow

How to get a change into `mcp-code-nav`. The rules a change must respect are in [PRINCIPLES.md](PRINCIPLES.md); the
shape of the code is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). [CONTRIBUTING.md](CONTRIBUTING.md) is the short
version. This file is the single home of the gate list, the test commands and the problem-report checklist.

## Setup

Node.js 20 or newer (CI runs 20 and 22) and npm. Language servers are needed only for the live suite and for trying your
change by hand; install them as the README's Requirements section describes, or point the `MCP_CODE_NAV_*` variables
listed under Tests at existing binaries.

```sh
git clone https://github.com/<your-account>/mcp-code-nav.git
cd mcp-code-nav
npm ci
```

That is your fork (step 1 below). Maintainers clone https://github.com/VitaliBabkin/mcp-code-nav.git directly.

Run the server from source with `npm run dev` (watches `src/`), or build it with `npm run build` and point an MCP client
at `dist/index.js` (see the README). `npm run bundle` writes a single self-contained file to `dist-bundle/index.js`.

## Branch and pull request

Steps 1 and 5 belong to the human contributor. An assistant works in the checkout it was given, does steps 2-4, and
stops with a report unless the user asks it to commit or open the pull request: the contributor owns their history, and
an unrequested commit or branch has to be undone by hand.

1. Fork the repository and branch from `main`. One logical change per branch.
2. Make the change together with its tests. Update the docs the change makes wrong or incomplete: the README tool table
   and `docs/ARCHITECTURE.md` when a tool, response shape, configuration or environment variable changes, and TSDoc on
   the exported symbols you add or change. Do not document code you did not touch. Docs land in the same pull request,
   not a later one.
3. Run the gates below locally, so the pull request is not their first run.
4. Check that the change is complete: the tests and docs it needs exist and the gates pass. Then stop and report what
   changed and why, which rule in `PRINCIPLES.md` it touches, which gates ran, and which live tools were present. Add
   nothing that was not asked for; mention unrelated bugs or cleanups at the end instead of fixing them, so the diff
   stays reviewable.
5. Open a pull request against `main` with that report: what changed and why, which rule in `PRINCIPLES.md` it touches
   if any, and how you checked it (which tools the live suite ran against).

CI runs the three gates on Linux (Node 20 and 22) and Windows (Node 22). It also runs the live suite on Linux; that job
is advisory (`continue-on-error` in `.github/workflows/ci.yml`) and a maintainer reads its result. A pull
request merges when the three-gate jobs are green and a maintainer has approved it.

## Gates

Three gates must pass locally before a change is reported done. They supplement CI, which also covers Node 20 and
Windows.

| Command             | What it checks                                                                          |
| ------------------- | --------------------------------------------------------------------------------------- |
| `npm run lint`      | ESLint over `src` and `scripts`: at most 150 lines per function, cognitive complexity 25 |
| `npm run typecheck` | `tsc --noEmit` for `src`, then `tsc -p tsconfig.scripts.json` for `scripts`             |
| `npm test`          | The default suite (vitest). Needs only Node; no language server is started              |

A docs-only change needs no gate. A conditional fourth check, `npm run test:live`, runs the same code paths against the
real tools; run it when the change touches behaviour that depends on a real binary (see Tests).

Lint and typecheck cover `src` and `scripts`; test files are checked only by running them.

There is no formatter. Match the surrounding code: two-space indent, double quotes, semicolons, trailing commas in
multi-line literals, `node:` prefix on Node built-ins, `.js` extensions in relative imports.

Aim for functions under 80 lines; 150 is the hard lint limit. Count lines the way the lint rule does (blank lines and
comments excluded). A function already over 80 lines takes no new behaviour: put it in its own named function. A fix
that adds no lines is fine.

`npm test` includes `test/no-internal-references.test.ts`. It scans `src`, `test`, `scripts`, `docs`, `.github` and the
top-level `*.md` and `package.json` (not commit messages), and fails on lines that name a private design record, a
review round, a private workspace or a personal path; the exact patterns are in that file. Write the behaviour in the
text itself and link only to files in this repository or to public specifications.

## Tests

`npm test` is the default gate. It replaces language servers with scripted fakes (`test/helpers/fake-lsp.ts`,
`fake-clangd.ts`, `fake-go.ts`) and injects `spawn`, `exec` and `readFile`, so it is deterministic and fast. Run one
file with `npm test -- test/tools/input-limits.test.ts`. What a change must test is PRINCIPLES.md rule 10.

`npm run test:live` runs `test/**/*.live.test.ts` against real binaries, one file at a time. It starts by printing which
tools it found.

| Tool          | Used by          | How it is found                                                 |
| ------------- | ---------------- | --------------------------------------------------------------- |
| `clangd`      | C++ live files   | `clangd` on `PATH`, or `MCP_CODE_NAV_CLANGD`                    |
| `clang-query` | C++ live files   | `clang-query` on `PATH`                                         |
| `gopls`       | Go live files    | `gopls` on `PATH`, or `MCP_CODE_NAV_GOPLS`                      |
| `tsgo`        | TypeScript files | global `typescript@7`, or `MCP_CODE_NAV_TSGO` (the executable)  |

A live file whose tool is missing skips its cases, so a pass on a bare machine proves nothing about that tool. Set
`MCP_CODE_NAV_LIVE_REQUIRE=all` (or a comma-separated list such as `gopls,tsgo`) to make a missing tool fail the run.
Changing behaviour that depends on a real binary requires running the matching live files with that tool installed. If a
tool your change needs is not installed, install it or, when you cannot, say in the pull request (or your report) which
live files were skipped and why. Do not report a skipped live run as a pass. The minimum version of every tool is the
README's Requirements table, and the live suite has to pass at those minimums. CI's `live` job runs twice, once with
every tool at its minimum and once with every tool at its latest release: clang-query from `apt`, clangd from its GitHub
release, Go with gopls (`go install golang.org/x/tools/gopls@<version>`), and `typescript@<version>` installed globally.
The job is advisory (`continue-on-error`) until it has been seen green on a hosted runner. Raising a minimum, or finding
that the suite no longer passes at one, changes the README table and the `live` matrix in `.github/workflows/ci.yml` in
the same commit. The `clang-cl` cases of `find-derived-classes.live.test.ts` (the MSVC-style note format) skip
when `clang-cl` is not on `PATH`; the CI runners have none, so those cases run only on a developer machine.

## Review

Authors: expect review on correctness first: does the change keep every rule in `PRINCIPLES.md`, in particular that no
cold or unindexed input produces a silent empty result, that failures are `isError` results with a stated cause, and
that inputs are validated before they reach a process or the disk. Then structure and tests. A change that adds or
alters a tool, a response shape, a configuration file format or an environment variable is a public-surface change:
describe it in the pull request and update the README in the same change. Reviewers may ask for a live test where a mock
could not have caught the problem.

Reviewers: report every defect you find, including uncertain and low-severity ones, each with a confidence and a
severity, so the author can decide what to act on. Order the report correctness, then structure, then tests.

## Adding a tool for a new language

Before step 1, open an issue so the readiness proof (PRINCIPLES.md rule 1) and the scope of the first tools are agreed
before the code is written. An assistant asks its user to do this and waits.

A language is a language server plus a family of tools.

1. **Server configuration.** In `src/lsp/server-config.ts` add a `LanguageServerConfig` for the server: command and its
   `MCP_CODE_NAV_*` override variable, install hint, argv, child environment, `initializeParams`, and `allowedRequests`.
   `allowedRequests` is the only list of methods the session will send; admit nothing a tool does not need. Extend the
   `id` union. Decide how the server proves readiness (`readinessProof`, `documentSymbolNeedsWarmth`) and, if it holds a
   package graph or index, how disk changes are pushed (`moduleSnapshot`, `indexSnapshot`); see PRINCIPLES.md rules 1
   and 6. Record the decision in the issue and the pull request.
2. **Backend helpers.** Add `src/<server>/` for what is specific to it: finding the project or module root, locating the
   binary, converting outlines.
3. **Tools.** Add one file per tool in `src/tools/`, named `<lang>-<question>.ts` with a tool name of the same form
   (`<lang>_<question>`). Each exports a `register...` function taking the `McpServer` and the `LspSessionManager`.
   Build the input from the zod pieces in `src/tools/input-limits.ts`, resolve paths through
   `src/paths/resolve-safe-path.ts`, return results through `src/mcp-response.ts`, and state the extent of the answer in
   `scope`.
4. **Wiring.** Register the tools in `src/index.ts`, describe them in `src/server-instructions.ts`, and add them to the
   tables in the README and the layout in `docs/ARCHITECTURE.md`.
5. **Tests.** Unit tests with a fake server under `test/`, a test that pins the cold state of the new readiness proof, a
   live file `test/<server>/*.live.test.ts` with fixtures under `test/fixtures/`, and an entry for the new binary in
   `test/helpers/live-requirements.ts` and `test/live-setup.ts`. Install the server in the `live` job in
   `.github/workflows/ci.yml`.

## Commit messages

One logical change per commit. The subject is a short imperative sentence in plain prose, in sentence case, with no
trailing period and no type prefix (for example `Report the package version unbundled`). Use the body to say why when it
is not obvious, and describe what the change does in the message itself rather than pointing at documents outside this
repository.

## Reporting problems

Include the tool name, the arguments (paths may be redacted), the language server and its version, and the server's
stderr output.
