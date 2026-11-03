# Backlog

Deferred tasks the maintainer has approved, picked by priority rather than in order. One row per task: what, why not
now, and the event that brings it back.

### 1. Go: answer across the modules of a `go.work` workspace

Size: L · Priority: ?

Today an answer covers the one module containing the named file and a `go.work` beside it is only reported; spanning
modules needs a workspace-level gopls session and a scope statement for each module it did and did not load. Re-entry
trigger: a user with a multi-module Go repository asks for it.

### 2. Per-file `hover`, `goToDefinition` and diagnostics tools, so one clangd per project serves both project-wide and per-file questions

Size: L · Priority: ?

The server exposes symbols, references and callers only; `allowedRequests` denies the rest, and diagnostics arrive as
an asynchronous `publishDiagnostics` stream the session does not consume. An agent client that also runs its own
language server for C++ keeps a second clangd per session. Re-entry trigger: the memory limits have shipped and a
client still needs a second language server for per-file answers.
