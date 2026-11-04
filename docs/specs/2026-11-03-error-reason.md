# Machine-readable reason on error results

Status: accepted.

## Problem

An error result carries its cause only as prose: `errorResult(text)` in `src/mcp-response.ts` returns a text block and
nothing else. A programmatic caller that wants to branch (retry later, fix the input, give up) has to parse English. The
call log already needs the same distinction and gets it by matching about 60 regex anchors against the text
(`src/call-log/error-class.ts`). That is fragile both ways: a reworded message drifts into `other`, and a symbol name or
path that contains an anchor phrase is classified by that phrase.

## Decision

Every error result this server builds carries a closed `reason` and a `retryable` flag in `structuredContent`, set where
the failure is decided, not recovered from the text afterwards.

### Wire shape

A plain error:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "<unchanged prose>" }],
  "structuredContent": { "reason": "not-ready", "retryable": true }
}
```

A partial result (`partialResult`, today only the `cpp_find_derived_classes` ceiling) keeps its payload and gains the
same two keys at its top level:

```json
{ "summary": "...", "reason": "budget-exceeded", "retryable": true, "...payload": "..." }
```

- The text stays exactly as it is now; `reason` adds to it and replaces nothing.
- `retryable: true` means the identical call may succeed later without any change to its arguments (the index warms, the
  child restarts, a larger budget is not required). `false` means the call must change (input, configuration, an
  installed binary) before it can succeed.
- `retryable` is a function of `reason` alone, from one table. A call site names the reason and never the flag, so the
  two cannot disagree.
- No tool declares an `outputSchema`, so an error's `structuredContent` does not have to match a success payload.

### Reasons

The call-log class set becomes the public vocabulary, with three additions the recon found missing (failures that today
fall into `other`).

| reason | retryable | meaning |
|---|---|---|
| `input-invalid` | false | the arguments fail the schema, or name something no tool can answer for: not a file nor directory, not a TS/JS source, a Go file outside the loaded package graph (`no package metadata`), a directory anchor with no project to open |
| `tool-unknown` | false | no tool has that name |
| `path-escape` | false | the path is outside every declared root or source root |
| `path-ambiguous` | false | a relative path exists under more than one root |
| `path-ignored` | false | the path is excluded by the project's ignored paths |
| `file-not-found` | false | the named file or anchor does not exist |
| `no-module` | false | the path is not inside a Go module or an npm package |
| `compile-db-missing` | false | `compile_commands.json` is missing or unreadable |
| `compile-db-invalid` | false | `compile_commands.json` is not valid JSON or not a compile database |
| `server-unavailable` | false | the language server or `clang-query` could not be started |
| `symbol-not-found` | false | the index is proven ready and holds no such declaration |
| `symbol-ambiguous` | false | the name matches several declarations and the server will not pick |
| `symbol-kind-unsupported` | false | the declaration's kind cannot answer this question (a class has no callers) |
| `not-ready` | true | readiness is not proven: cold index, workspace still loading |
| `budget-exceeded` | true | the call's own time budget or ceiling ran out |
| `request-timeout` | true | **new**: the server did not answer one request within the request timeout |
| `session-lost` | true | the child restarted or died during the call, including a request that failed because the child had exited |
| `cancelled` | true | **new**: the client cancelled the call |
| `sweep-failed` | false | every translation unit of a `clang-query` sweep failed with the same error |
| `unexpected-answer` | false | **new**: the server answered in a shape this server cannot read |
| `internal` | false | anything not above; replaces `other` |

`input-invalid` and `tool-unknown` are produced by the MCP SDK before a handler runs (its zod validation and tool lookup
catch the throw and build `{ isError, content }` themselves), so this server cannot attach `structuredContent` to them.
They stay in the table because the call log reports them; on the wire they are the errors that arrive **without**
`structuredContent`. The README states this: an error with no `reason` is a protocol-level refusal of the request as
sent, never retryable.

## Implementation shape

- `src/error-reason.ts`: `ErrorReason` (a string-literal union), `ERROR_REASONS`, `isRetryable(reason)`.
- `src/tools/reason-of-error.ts`: `reasonOfError(e: unknown): ErrorReason`, which maps a thrown value by type
  (it lives beside the error classes it imports, so `error-reason.ts` stays free of `tools/`): `PathEscapeError` ->
  `path-escape`, `AmbiguousRelativePathError` -> `path-ambiguous`, `IgnoredPathError` -> `path-ignored`,
  `CompileDbNotFoundError` -> `compile-db-missing`, `CompileDbInvalidError` -> `compile-db-invalid`,
  `LanguageServerUnavailableError` -> `server-unavailable`, `RequestTimeoutError` -> `request-timeout`,
  `RequestAbortedError` -> `cancelled`, `ServerExitedError` -> `session-lost`, a Node error with
  `code === "ENOENT"` -> `file-not-found`, anything else -> `internal`. A wrapper keeps the failure it wraps as
  `cause`, and the chain is read outward until a link names a reason.
- `errorResult(text, reason)` and `partialResult(text, reason, payload)`: `reason` is required, so the compiler finds
  every one of the 72 call sites.
- The shared helpers that return `{ ok: false, error: string }` (`go-shared.ts`, `go-navigation-shared.ts`,
  `ts-shared.ts`, `ts-navigation-shared.ts`, `cpp-navigation-shared.ts`, `lsp-locations.ts`) return
  `{ ok: false, error: string, reason: ErrorReason }`. Each text producer names its reason beside its text; a helper
  that prefixes or wraps a text passes the reason through.
- The tool catch-alls (`${TOOL} failed: ${messageOf(e)}`, one per tool) use `reasonOfError(e)`.
- Errors that lose their type today get it back:
  - `withServerStderr` (`src/lsp/session.ts`) appends the stderr tail to a timeout and to the failure of a request
    whose child is no longer alive. A timeout keeps the original as `cause`. Any other failure of a dead child, which
    names nothing in itself (`Connection is closed`, `connection got disposed`), becomes a `ServerExitedError` with
    the same text and the original as `cause`, so it reads as `session-lost`. A cancellation and an unavailable
    binary pass through untouched.
  - `defaultClangQueryExec` turns a missing `clang-query` into `stderr = "Error: spawn clang-query ENOENT"`; the sweep
    reports that as `server-unavailable`, not `sweep-failed`.
  - `compile-db.ts` throws a `ZodError` for a well-formed JSON that is not a compile database; it becomes
    `compile-db-invalid`.
- The call log reads `structuredContent.reason` when the result carries one. A result without it (the SDK's two, and
  every result `npm run stats` reads from a Claude Code transcript, which carries the text and no
  `structuredContent`) goes through text classification: the anchor table stays, every class it returns is a member
  of `ERROR_REASONS`, and its fallback is `internal` where it was `other`. An anchor and the reason beside the same
  text name the same class. `errorHead` is unchanged. The record field keeps its name, `errorClass`, so existing
  logs and `npm run stats` keep working; `npm run stats` reads the `other` of an older log and the `internal` of this
  one as the same unclassified class. A failure with no text and no reason logs no class, as before.

## What does not change

- Every error text, word for word, but one: a `compile_commands.json` that parses but is not a compile database used to
  surface zod's raw issue dump and now says it "is not a compile database: ...". The tests that pin texts stay as they
  are.
- Success results.
- `isError` semantics, including partial results.

## Tests

- Each tool's unit tests: every error case that exists today also asserts its `reason`. The tests that pin "an error
  result has no `structuredContent`" (about 12, in the `ts-find-*`, `cpp-degraded-outline`,
  `cpp-find-derived-classes` and live suites) change to pin `{ reason, retryable }` instead.
- `reasonOfError`: one case per mapped type, ENOENT, a non-Error throw.
- `isRetryable`: a table test over `ERROR_REASONS`, so a new reason without a decided flag fails to compile or fails the
  test.
- Call log: a result with `reason` is logged with it even when its text contains another class's anchor phrase (the
  symbol-name case that misclassifies today); a result without `reason` is classified by its text, to a member of
  `ERROR_REASONS`.
- Regression cases for the three type losses above (timeout with a stderr tail, missing `clang-query`, non-database
  JSON).

## Documentation

- README: a "Reading errors" section with the reason table, the `retryable` rule, and the no-`reason` rule for SDK
  refusals.
- `docs/PRINCIPLES.md` rule 2: an error names its cause in `reason` as well as in prose.
- `src/mcp-response.ts`: drop the references to a `mcp-tool-response-contract.md` that is not in the repository.

## Slices

1. Core: `src/error-reason.ts`, `errorResult`/`partialResult` signatures, `reasonOfError`, the call-log change, the
   three type-loss fixes. Tool files get the reason at each site in the same slice, because the required parameter does
   not compile otherwise; split by language only if the diff is too large to review in one pass: C++ (29 sites), Go
   (21), TS (21).
2. Tests and docs as above, in the same PR.

## Done when

- Every error result built in `src/` carries a `reason`; the compiler enforces it.
- The call log takes the reason from the result; its anchor table serves only results without one.
- The gates and the live suite pass; every live error case asserts its `reason`.
- The README table and `ERROR_REASONS` are the same list, held by a test.
