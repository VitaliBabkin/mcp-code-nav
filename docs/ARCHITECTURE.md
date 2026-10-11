# Architecture

`mcp-code-nav` is a stdio MCP server. Each tool translates a navigation question into requests to a language server
(or, for C++ class hierarchies, to `clang-query`), then renders the answer together with a statement of what the answer
could not see.

## Layout

```
src/
  index.ts          wiring: builds the MCP server, registers the tools, owns shutdown
  lsp/              generic language-server plumbing
    process.ts        spawn a child, JSON-RPC over stdio, lifecycle (error/exit handling)
    session.ts        one live server per (server kind, root): handshake, readiness, request allow-list, respawn-once
    session-manager.ts  lazily creates and caches sessions
    server-config.ts  one LanguageServerConfig per backend: command, env override, argv, capabilities, allowed requests
    module-freshness.ts  proves a server's package graph is current before a type-aware answer is served
  clangd/ gopls/ tsgo/ clang-query/   per-backend helpers (outline conversion, module/workspace discovery, binary lookup)
  paths/            source-root containment, relative-path resolution, index-drift detection
  tools/            one file per tool (input schema, handler, text rendering) plus shared helpers per language
  call-log/         optional per-call usage log (JSONL) and its stdio tap
scripts/            bundle (esbuild), build identity, call-stats report
test/               fast suite with fakes; *.live.test.ts run against real tools; fixtures/ holds sample projects
```

## Key ideas

- **A backend is configuration.** Adding a language server means adding a `LanguageServerConfig`; `LspSession` is shared.
  The config also lists the only LSP methods the session may send, enforced in one place.
- **Answers state their limits.** Tool results carry a `scope` block (files not searched, index still building, module
  boundary, fuzzy-match cap reached) so an agent can tell a complete answer from a partial one.
- **Failure is contained.** A missing binary, a crashed child or a bad configuration becomes a tool error with an
  install hint; it never takes the MCP server down. A dead child is respawned once and the request retried.
- **Inputs are validated at the boundary.** Tool arguments go through zod schemas; paths are checked against the declared
  `sourceRoots`; processes are spawned with argv arrays, never through a shell.
- **stdout is the protocol.** Diagnostics are written to stderr only.
- **Read-only.** The server never writes to the sources it analyses. clangd keeps its own index under `.cache/clangd`
  in the project root. The optional call log writes to the absolute directory the operator names.

## Class names from `clang-query` locations

`cpp_find_derived_classes` reads the class name from source at the location `clang-query` binds, so the name is only as
good as that location.

- A `cxxRecordDecl` binds at the start of the full declaration. A class-template primary pattern binds at the
  `class`/`struct` key after the `template <...>` header. Every other template form (implicit instantiation, partial
  specialization, explicit specialization) binds at the `template` keyword.
- `className` is never a C++ keyword. Reading a `template` bind location means skipping the whole header (it spans
  lines, nests angle brackets and non-type parameters, and may be empty), then an optional `requires` clause, the
  `class`/`struct`/`union` key and any attributes, and returning the next identifier.
- Partial and explicit specializations are real declarations reachable only through their `template` bind. Recover the
  name; do not filter the row out. Rows for different forms of one template share a `className` and differ in
  `line`/`column`.
- A bind location that yields a keyword, an unterminated header, or a `requires` clause without a class key is reported
  in `failedFiles` as an extraction failure, never as a row.
- The reported column is a 1-based byte offset in the line while the source is read as UTF-16; convert before indexing.
- A fix in this area ships with a live regression test on a fixture that derives through a template, a partial
  specialization, an explicit specialization and an instantiation of each. Mocked `clang-query` output cannot show any
  of this.

## Tests

The default suite replaces the language server with a scripted fake (`test/helpers/fake-lsp.ts`, `fake-clangd.ts`,
`fake-go.ts`) and injects `spawn`, `exec`, file reads and sleeps, so it is deterministic and runs in seconds. The live
suite exercises the same code paths against the real tools; see `docs/WORKFLOW.md`.
