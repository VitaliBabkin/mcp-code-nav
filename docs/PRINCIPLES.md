# Principles

The invariants every change to `mcp-code-nav` must keep. A change that breaks one is wrong even if its tests pass; a
change that needs to bend one stops and asks the maintainers (an issue, or the user an assistant is working for)
before it is written; if they agree, the pull request names the rule and gives the argument.

The server exists to give a coding agent navigation answers it can trust more than grep. A confident wrong answer is
worse than a slow one or an honest "I could not tell", so most rules below are about never presenting a guess as a fact.

## 1. Never guess an empty result

Readiness is a property of a (language server, query class) pair, not of a server. An empty response is returned as an
answer only where the server can prove it is warm for that class of query. Otherwise the result is `isError: true` and
says why.

- **clangd `documentSymbol`**: an empty outline is ambiguous between an empty file and an unfinished parse. Until a
  clangd process has produced one non-empty response, an empty outline is an error.
- **clangd index-backed queries** (`references`, call hierarchy, `workspace/symbol`): indexing is re-entrant, so there
  is no one-shot proof. The proof is that no indexing is in flight at answer time; an empty answer produced while
  indexing runs, or while no indexing progress has ever been observed, is an error.
- **clangd without a compile database**: an outline is an answer only when it is non-empty and says it was parsed
  without one (`parsed-without-compile-database`). An empty one proves nothing about the file.
- **gopls**: `documentSymbol` is correct from the first call. Type-aware queries (`implementation`, `references`, call
  hierarchy, `hover`, `workspace/symbol`) are gated on the end of the initial workspace load; an empty answer before
  that is an error, never "nothing implements it" or "nothing uses it".
- **tsgo**: sends no progress and loads a project while handling `didOpen` of a file in it. The proof is that every
  project anchor and the named file were opened on the process that answers. An empty answer under that proof is an
  answer; one from a process replaced mid-call is an error.
- **`clang-query` sweeps**: an empty `matches` that is empty only because every translation unit that ran failed the
  same way is an error naming that shared failure, never an empty hierarchy.

A non-empty response never substitutes for the proof: an out-of-scope type-aware query returns a plausible, non-empty,
incomplete set.

A new backend or query class states its readiness proof before it ships, and a test pins the cold case.

## 2. Errors are for the caller to branch on

- An execution failure is a normal tool result with `isError: true` (see `errorResult` and `partialResult` in
  `src/mcp-response.ts`), never a thrown JSON-RPC error. A JSON-RPC error is reserved for a request the protocol itself
  cannot carry.
- Every `isError: true` text names why: cold index, ignored path, path escape, ambiguous match, no match, missing
  language server, `clang-query` compile failure. A caller (human or agent) must be able to decide what to do next
  without re-deriving the cause from a generic message.
- A partial answer is `isError: true` with the partial payload attached and a block stating how much of the scope was
  covered. It is never an empty success.
- A missing binary, a crashed child or a bad configuration becomes a tool error with an install hint. It never takes the
  server down.

## 3. Hierarchy questions are transitive

"Who derives from X" is answered exclusively by `clang-query`: `isDerivedFrom` for the transitive tree,
`isDirectlyDerivedFrom` for classes that name `X` as a base themselves. No code path may answer either question with a
single-level LSP `textDocument/implementation` call; that is the one class of question such a call provably gets wrong
(a grandchild override silently missing).

- Neither depth is a safe substitute for the other. `cpp_find_derived_classes` takes a `derivation` parameter that
  defaults to `transitive`. The direct question answered transitively is silently over-broad; the transitive question
  answered directly silently loses every grandchild. The response echoes which view was answered.
- Both views come from one sweep, so they cannot disagree about the same class.
- The rule is enforced mechanically: every request a session sends passes one choke point that admits only the methods
  its server's config allows, and no clangd config admits `textDocument/implementation`.
- Go and TypeScript implementation questions are answered by `textDocument/implementation` of gopls and tsgo, because
  there the type checker is the only correct source (Go satisfaction is structural and implicit). tsgo follows
  `implements` and `extends`; a type that satisfies an interface only structurally is not reported, and the answer says
  so.
- A `direct` answer is a candidate set scoped to the swept translation units, not a claim about the whole repository. An
  empty `direct` result from a complete sweep is a correct answer for that scope. No result field may imply a scope
  wider than `sweep.totalTus`. C++ sources that no compile-database entry compiles are named in `sweep.uncoveredSources`
  (or the reason that could not be determined in `sweep.uncoveredSourcesUnavailable`), never silently dropped.

`cpp_find_derived_classes` reads each class name from source at the location `clang-query` binds. `className` is never a
C++ keyword; a bind location that yields none is a `failedFiles` entry, never a row. A fix to name extraction ships with
a live regression test on a template fixture, run with `clang++` and also with `clang-cl` where that driver is
available (Windows); say in the pull request which drivers you ran. The extraction rules are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## 4. Validate input before it reaches a process or the disk

- Every tool input goes through a zod schema. Shared limits live in `src/tools/input-limits.ts` (`PathInput`,
  `NameInput`, `PathList`). A new free-text or path argument uses them.
- Every `file`/`files` input is resolved and checked to stay within `projectRoot` or one of the call's effective
  `sourceRoots` before it is used to spawn a process or read a file. The schema catches shape; the `..`-escape check
  lives in the handler. Containment is checked lexically first, then on the real path with symlinks and junctions
  followed, and before any disk access, so a candidate outside every root is never stat'ed.
- A relative path is resolved against the roots and must exist under exactly one. Existing under several is an error
  naming the candidates, never a pick by root order.
- When a C++ caller declares no `sourceRoots`, the tool derives one: the nearest ancestor of `projectRoot`, at most four
  levels up, never a filesystem root, that holds a translation unit the compile database names outside `projectRoot`.
  Every answer that depends on it names the root and its origin.
- Configuration read from a project (`mcp-code-nav.config.json`) is validated and bounded like any other input. A file
  that breaks a limit is rejected whole, with a message naming the rule.
- Environment variables and other external data are parsed through a schema, never cast.

## 5. Narrow scope, no hidden state

- The server is read-only on the caller's sources. The only thing it causes to appear in a project is clangd's own index
  directory (`.cache/clangd`, beside a `.gitignore` clangd writes). The one other thing it writes is the optional call
  log (rule 9), into the absolute directory the operator names; it never chooses a location under the caller's sources.
- The server builds no index of its own: no sweep, no blind walk of the project. It uses the index each language server
  builds for itself (clangd's background index, gopls's package graph, tsgo's project graph) and states that index's
  state in the answer (`scope.index.state`, `scope.freshness`). A result list that hit a cap is reported as capped.
- Where the caller names a file, the symbol is resolved from that file's outline, not by a search.
- tsgo project membership is read from `tsc --listFilesOnly`, the compiler's own rule, never from a re-implemented glob.
  For a TypeScript source no project includes, the answer names the files whose text mentions the subject as a pointer
  for a text search; a mention is never counted as a use.
- Every answer states its extent in `scope`. New output never implies a wider scope than was searched.
- A new feature adds a tool or a field to an existing answer only when a coding agent has a navigation question the
  current tools answer wrongly or not at all. Convenience wrappers around what a client can already do are out of scope.

## 6. A cached answer is served only while it is provably current

- Sweep results are keyed by a fingerprint of the project's sources and the compile database. A fingerprint that cannot
  be computed within its bounds disables the cache for that call, and the response says so. Slow is acceptable; a stale
  hierarchy is not.
- A cache entry stores only facts no request parameter can vary. A parameter that changes what is computed joins the key
  (`qualifiedName` does); a parameter that only selects a view of a fully computed entry does not (`derivation` does
  not). A translation unit whose `clang-query` run failed is never served from cache.
- gopls and tsgo hold a loaded package graph and hear of disk changes only from their client. Before every type-aware
  call the session snapshots the relevant files (Go: `.go`, `go.mod`, `go.work`; TypeScript: sources, `package.json`
  files and every config reached by `references` and `extends`), pushes what changed (`didClose`, then
  `workspace/didChangeWatchedFiles`), and disposes the session if the snapshot cannot be taken within its bound. Slow,
  never stale.
- clangd's background index cannot be made current by a push, which only enqueues re-indexing. The diff is therefore
  reported as drift, never as freshness; a diff that cannot be taken is reported as unknown drift. An answer known to be
  behind the disk says so.
- Any cache added later follows the same rules.

## 7. A long operation is bounded and visible

- Work whose cost scales with the project (the unscoped `clang-query` sweep) runs under an explicit wall-clock ceiling
  sized above the whole sweep, and reports progress when the client asked for it.
- Hitting the ceiling returns `isError: true` with the partial payload and an `incomplete` block naming how much of the
  scope was covered. Work interrupted by the ceiling or by client cancellation is reported as not-yet-checked, never as
  a failed translation unit.
- A language-server request left unanswered past the request timeout (default in `src/lsp/request-control.ts`,
  override `MCP_CODE_NAV_REQUEST_TIMEOUT_MS`) is cancelled and fails with an error naming the server and method; the late answer is discarded.
- Client cancellation cancels the language-server requests and helper processes started for that call.

## 8. Process hygiene

- stdout belongs to the MCP protocol. Never write to it; diagnostics go to stderr.
- External processes are spawned with an argv array, never through a shell. The one exception is `npm` on Windows in
  `src/tsgo/binary.ts`.
- Every child is owned by exactly one session, is killed on shutdown, on client disconnect and on session disposal, and
  never outlives the server. A dead child is respawned once and the request retried; a second failure is an error.
- A language server's stderr is drained continuously (its tail is appended to the error of a request that failed because
  the server died or hung), so a chatty child can never block on a full pipe.
- Async code has no floating promises; every promise is awaited, returned or explicitly handled. Errors carry context
  (`new Error("doing X", { cause })`) and are handled at one layer, not logged and rethrown at several.

## 9. Observation never affects an answer

The optional per-call log (`MCP_CODE_NAV_CALL_LOG`, off by default) records what happened and changes nothing that
happens. It is written after the response is sent, its failure is one stderr line and never a tool failure, it records
no source text and no result text, and every report built on it states the failures it cannot see (those that never
reach the server).

## 10. Tests

- Every change ships its tests, written with the code. A bug fix ships a regression test that fails before the fix.
- The default suite (`npm test`) runs with only Node installed. Language servers and `clang-query` are replaced at the
  process boundary by injectable `spawn`/`exec`/`readFile` seams and the fakes in `test/helpers/`.
- A mock reproduces only the shapes its author anticipated. Behaviour that depends on what a real binary does (output
  formats, readiness signals, path spellings) gets a `*.live.test.ts` case against the real tool and a fixture under
  `test/fixtures/`.
- For each query class, add one test per state that class can return: rule 1 lists the cold cases, and the tool's result
  type lists the capped, partial and unavailable ones (rule 1 is tested, not assumed).
- Fixtures are read-only data. A test that writes uses a temporary directory and removes it.
- A failing test is information. Find the cause and fix the code, or fix the test only when the test is what is wrong,
  and say so in the pull request. Loosening an assertion or deleting the test to get green hides the defect it found.
- Published files carry no references to private documents, review rounds or locations (paths, hosts, trackers) that
  readers of this repository cannot reach; public specifications and upstream documentation may be linked.
  `test/no-internal-references.test.ts` enforces the exact patterns.
