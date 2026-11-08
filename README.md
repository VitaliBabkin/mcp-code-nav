# mcp-code-nav

[![CI](https://github.com/VitaliBabkin/mcp-code-nav/actions/workflows/ci.yml/badge.svg)](https://github.com/VitaliBabkin/mcp-code-nav/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your AI coding agent greps. This server answers.** Who calls this function, every real use of this symbol, who
implements this interface or derives from this class: asked of the real language server instead of guessed from text,
and every answer says what it could not see. It is an [MCP](https://modelcontextprotocol.io) server for C++, Go and
TypeScript.

On our measurements (five questions, two real code bases, blind agents, details in [What it saves](#what-it-saves)):

| Question                         | Agent with grep only         | Agent with mcp-code-nav | Tokens |
| -------------------------------- | ---------------------------- | ----------------------- | ------ |
| Go: who calls a common method    | correct, 16 tool calls       | correct, 2 tool calls   | -78%   |
| C++: every use of a method       | 6 of 7 found                 | 7 of 7                  | -70%   |
| C++: who calls a virtual method  | 5 found plus 2 false callers | exact                   | -66%   |

Try it in five minutes: [Quick start](#quick-start). It drives real language servers behind one stdio server:

| Language   | Backend                                         | Tools                                                                                                              |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C++        | `clangd` and `clang-query`                      | `cpp_file_symbols`, `cpp_find_symbol`, `cpp_find_references`, `cpp_find_callers`, `cpp_find_derived_classes`       |
| Go         | `gopls`                                         | `go_file_symbols`, `go_find_symbol`, `go_find_references`, `go_find_callers`, `go_find_implementations`            |
| TypeScript | the TypeScript 7 native server (`typescript@7`) | `ts_file_symbols`, `ts_find_symbol`, `ts_find_references`, `ts_find_callers`, `ts_find_implementations`            |

Every answer says what it could **not** see (a `scope` block: files no project includes, an index that is still
warming up, a module boundary, and so on) instead of presenting a partial result as complete. The server never writes to
your sources.

## Quick start

**Or download a prebuilt release.** Nothing to clone or build: Node.js 20 or newer is the only requirement besides the
language servers you use (see [Requirements](#requirements)).

1. Download `mcp-code-nav.js` from the [Releases page](https://github.com/VitaliBabkin/mcp-code-nav/releases), together
   with `SHA256SUMS` if you want to verify it.
2. Optionally verify it, in the download directory:

   ```sh
   sha256sum -c SHA256SUMS
   gh attestation verify mcp-code-nav.js --repo VitaliBabkin/mcp-code-nav
   ```

3. Register `/absolute/path/to/mcp-code-nav.js` in your MCP client as described in
   [Register it in an MCP client](#register-it-in-an-mcp-client). To check the start-up, run the script from step 5 of
   the build path below with `node - mcp-code-nav.js` in place of `node - dist/index.js`.

To build from source instead (the path for contributors):

1. Check Node: `node --version` must print 20 or newer.
2. Install the language server for each language you want, at least the minimum in the [Requirements](#requirements)
   table. All are optional; install only the ones you use.
3. Clone and build (details in [Install and build from a clone](#install-and-build-from-a-clone)):

   ```sh
   git clone https://github.com/VitaliBabkin/mcp-code-nav.git
   cd mcp-code-nav
   npm ci
   npm run build
   ```

4. Register `dist/index.js` in your MCP client as described in
   [Register it in an MCP client](#register-it-in-an-mcp-client).
5. Check that the server starts and lists its tools, from the repository root (a POSIX shell; on PowerShell save the
   script body as `check.cjs` and run `node check.cjs dist/index.js`):

   ```sh
   node - dist/index.js <<'EOF'
   const { spawn } = require("node:child_process");
   const server = spawn("node", [process.argv[2]], { stdio: ["pipe", "pipe", "inherit"] });
   const send = (message) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
   let buffer = "";
   server.stdout.on("data", (chunk) => {
     buffer += chunk;
     for (const line of buffer.split("\n").slice(0, -1)) {
       const reply = JSON.parse(line);
       if (reply.id === 1) {
         console.log("server:", reply.result.serverInfo.name, reply.result.serverInfo.version);
         send({ method: "notifications/initialized" });
         send({ id: 2, method: "tools/list" });
       } else if (reply.id === 2) {
         console.log(reply.result.tools.length, "tools:", reply.result.tools.map((t) => t.name).join(", "));
         server.kill();
       }
     }
     buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
   });
   send({
     id: 1,
     method: "initialize",
     params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } },
   });
   EOF
   ```

   It prints two start-up lines from the server on stderr, then `server: mcp-code-nav <version>` and
   `15 tools:` followed by the tool names. This proves the build and the protocol handshake only; it starts no
   language server, so it does not tell you whether `clangd`, `gopls` or `tsgo` is installed. The first real call does.

A first call: ask your agent, for example, "who calls `Store.save` in `/src/web`?". It should pick `ts_find_callers`
with `{"sourceRoots": ["/src/web"], "file": "src/store.ts", "symbol": "Store.save"}`. If the TypeScript 7 server is
missing, the result is an error that says how to install it. See [Using it](#using-it) for what to expect from answers.

## Requirements

- Node.js 20 or newer.
- The language servers for the languages you want. Each is optional; a tool whose server is missing returns an error that
  says how to install it. The versions below are what the live suite (`npm run test:live`, see
  [WORKFLOW.md](docs/WORKFLOW.md)) passes against on Linux: the minimum is the oldest release the suite passes on, and
  one release below it fails. The server does not check these versions at run time, so an older tool is used as it is.

| Tool                       | Minimum                   | Tested with                                                    |
| -------------------------- | ------------------------- | -------------------------------------------------------------- |
| Node.js                    | 20                        | 20.20.2, 22                                                    |
| `clangd`                   | 22.1.0                    | 22.1.0, 23.1.0                                                 |
| `clang-query`              | 14                        | 14.0.6, 18.1.3, 20.1.2, 22.1.8                                 |
| `gopls`                    | v0.15.0 (with Go 1.21)    | v0.15.0 with Go 1.21.13, v0.23.0 with Go 1.27.2                |
| TypeScript 7 native server | `typescript@7.0.1-rc`     | 7.0.1-rc, 7.0.2                                                |

Why `clangd` 22: older releases (18 to 21 were run) differ from 22 in two things this server relies on. A call-hierarchy
query on an override does not list the call sites written against the base declaration, and the index directory has no
`.gitignore` of its own, so the answer to `cpp_find_callers` on a virtual method is smaller than the documented one and
the index shows up in `git status`. A `gopls` older than v0.15.0 (v0.14.2 was run) fails to resolve a method under both
receiver spellings. The servers are looked up like this:

| Server                 | How it is found                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `clangd`               | `clangd` on `PATH`, or the absolute path in `MCP_CODE_NAV_CLANGD`                                          |
| `clang-query`          | `clang-query` on `PATH` (used only by `cpp_find_derived_classes`)                                          |
| `gopls`                | `gopls` on `PATH`, or the absolute path in `MCP_CODE_NAV_GOPLS`                                            |
| TypeScript 7 (`tsgo`)  | the globally installed `typescript@7` package (`npm install -g typescript@7`), or the executable in `MCP_CODE_NAV_TSGO` |

The C++ tools need a `compile_commands.json` produced by a build on the same host (the directory that holds it is the
`projectRoot` argument). With CMake, ask for one and pass the build directory as `projectRoot`:

```sh
cmake -S <src> -B <build> -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

The Go tools need a Go module on the host. The TypeScript tools answer for the npm workspace that holds the file you
name; `tsgo` does not have to be on `PATH`, because the globally installed `typescript@7` package is found for you.

## Install and build from a clone

```sh
git clone https://github.com/VitaliBabkin/mcp-code-nav.git
cd mcp-code-nav
npm ci
npm run build
```

This produces `dist/index.js`. Optionally, `npm run bundle` writes a single self-contained file to
`dist-bundle/index.js`, which you can copy anywhere Node runs.

To run a local build from a stable place, `npm run deploy` bundles the server and installs it as
`~/.mcp/mcp-code-nav/index.js`: it refuses a tree with uncommitted changes (`--allow-dirty` overrides, with a warning),
keeps the previous file as `index.js.bak`, checks the installed copy by an MCP handshake and prints its build identity.

## Register it in an MCP client

The server speaks MCP over stdio. Point `args` at the downloaded `mcp-code-nav.js`, or at `dist/index.js` of your build.
For a client that uses the common `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "code-nav": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-code-nav/dist/index.js"],
      "env": {
        "MCP_CODE_NAV_CLANGD": "/usr/bin/clangd"
      }
    }
  }
}
```

On Windows, use an absolute path with escaped backslashes and point `MCP_CODE_NAV_CLANGD` at `clangd.exe`
(`where clangd` prints its location):

```json
{
  "mcpServers": {
    "code-nav": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-code-nav\\dist\\index.js"],
      "env": {
        "MCP_CODE_NAV_CLANGD": "C:\\Program Files\\LLVM\\bin\\clangd.exe"
      }
    }
  }
}
```

`env` is optional; set only the overrides you need. Claude Code users can run
`claude mcp add code-nav -- node /absolute/path/to/mcp-code-nav/dist/index.js`.

Diagnostics go to stderr; stdout belongs to the protocol.

## Tools

Every tool takes `sourceRoots` (the directories it may read; relative paths resolve against exactly one of them) and,
for the Go and TypeScript tools, an optional `timeBudgetMs`. The C++ tools also take a `projectRoot` (the build
directory with `compile_commands.json`); for them `sourceRoots` is optional and defaults to its source tree.

| Tool                        | Question it answers                                                    | Example arguments                                                                           |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `cpp_file_symbols`          | What is declared in this C++ file?                                     | `{"projectRoot": "/src/app/build", "file": "src/widget.h"}`                                 |
| `cpp_find_symbol`           | Where is this C++ name declared?                                       | `{"projectRoot": "/src/app/build", "name": "ui::Widget::paint"}`                            |
| `cpp_find_references`       | Every use of a C++ symbol                                              | `{"projectRoot": "/src/app/build", "name": "ui::Widget::paint"}`                            |
| `cpp_find_callers`          | Who calls this C++ function                                            | `{"projectRoot": "/src/app/build", "name": "ui::Widget::paint"}`                            |
| `cpp_find_derived_classes`  | Every class deriving from a base, transitively or direct only          | `{"projectRoot": "/src/app/build", "qualifiedName": "ui::Shape", "derivation": "direct"}`   |
| `go_file_symbols`           | What is declared in this Go file?                                      | `{"sourceRoots": ["/src/svc"], "file": "store.go"}`                                         |
| `go_find_symbol`            | Where is this Go name declared?                                        | `{"sourceRoots": ["/src/svc"], "symbol": "Store", "anchor": "/src/svc"}`                    |
| `go_find_references`        | Every use of a Go symbol                                               | `{"sourceRoots": ["/src/svc"], "file": "store.go", "symbol": "Store.Get"}`                  |
| `go_find_callers`           | Who calls this Go function                                             | `{"sourceRoots": ["/src/svc"], "file": "store.go", "symbol": "Store.Get"}`                  |
| `go_find_implementations`   | What implements this interface, or what does this type implement?      | `{"sourceRoots": ["/src/svc"], "file": "store.go", "symbol": "Storage"}`                    |
| `ts_file_symbols`           | What is declared in this TypeScript/JavaScript file?                   | `{"sourceRoots": ["/src/web"], "file": "src/store.ts"}`                                     |
| `ts_find_symbol`            | Where is this TypeScript name declared (file or whole workspace)?      | `{"sourceRoots": ["/src/web"], "symbol": "Store", "anchor": "/src/web"}`                    |
| `ts_find_references`        | Every use of a TypeScript symbol                                       | `{"sourceRoots": ["/src/web"], "file": "src/store.ts", "symbol": "Store"}`                  |
| `ts_find_callers`           | Who calls this TypeScript function or method                           | `{"sourceRoots": ["/src/web"], "file": "src/store.ts", "symbol": "Store.save"}`             |
| `ts_find_implementations`   | Who implements this interface or extends this class                    | `{"sourceRoots": ["/src/web"], "file": "src/store.ts", "symbol": "Storage"}`                |

The authoritative argument schemas and descriptions are what the server publishes through `tools/list`.

## Using it

**When to use these instead of grep.** Reach for a tool when the question is about a symbol, not a string: the outline
of a file before you read it (`*_file_symbols`), where a name is declared (`*_find_symbol`), every real use of a symbol
as opposed to comments, strings and same-named identifiers (`*_find_references`), who calls a function
(`*_find_callers`), and who implements an interface or extends a class (`go_find_implementations`,
`ts_find_implementations`). For a C++ class hierarchy always use `cpp_find_derived_classes`: it answers transitively
(or direct-only on request), where a single-level guess misses grandchildren. Keep grep for text: a log message, a
config key, a comment.

**C++ `projectRoot`.** Pass the directory that holds `compile_commands.json`, from a build run on this host. A
database made in Docker, WSL or on another OS names paths this host cannot open: `cpp_find_derived_classes` then fails
and the clangd tools degrade, so use grep for that project. Without a valid database `cpp_file_symbols` still answers
from a default-flags parse and says so; the other C++ tools refuse.

**Reading `scope`.** Every answer states what it could not see. Check it before trusting an empty or short result:

- TypeScript: files that no `tsconfig` project includes (often tests) are not searched. When
  `scope.uncoveredSources.mentioning` lists files, the answer is incomplete: grep those files.
- C++: `scope.index.state` is `quiescent`, `building` or `unknown`. An empty answer from a `building` or `unknown` index
  is an error, not a result; call again once indexing has settled. `scope.index` also reports sources that changed on
  disk since the index was read, and `scope.limits` names caps, for example a listing that hit its cap. For
  `cpp_find_derived_classes`, `sweep.uncoveredSources` names sources under `sourceRoots` that no compile-database entry
  compiles, and `sweep.filesWithInferredFlags` names `files` entries with no entry of their own, whose rows rest on flags
  inferred from other entries.
- Go: an answer covers one module, under this host's `GOOS` and `GOARCH`; a `go.work` beside it is reported, not
  spanned.
- Counts are exact even when a listing is capped.

**Cold and warming up.** A language server starts on the first call that needs it, so that call is slower; a project
is loaded or indexed in the background. Until a server can prove it is ready for a kind of question, an empty answer is
returned as an error that says why, never as "nothing found" (see [PRINCIPLES.md](docs/PRINCIPLES.md), rule 1). Retry
after a moment. A request left unanswered for 180 seconds is cancelled (see
[Cancellation](#cancellation-timeouts-and-server-diagnostics)).

**Nothing is written to your sources.** The server only reads them. The one thing it causes to appear in a project is
clangd's own index under `.cache/clangd` in `projectRoot`, beside a `.gitignore` clangd writes itself.

## Reading errors

A failed call is a normal tool result with `isError: true`, never a protocol error. Its text says why, for a person. Its
`structuredContent` says why for a program, as `{ "reason": "not-ready", "retryable": true }`. A partial answer (today
only the C++ sweep ceiling, `cpp_find_derived_classes`) carries the same two keys beside its payload.

- `reason` is one of the values in the table below. It adds to the text and replaces nothing in it.
- `retryable: true` means the identical call, arguments unchanged, may succeed later: the index warms, a child restarts,
  a budget runs out. `retryable: false` means something must change first: the arguments, the configuration or an
  installed binary.
- `retryable` follows from `reason` alone, so a caller that branches on either one reaches the same decision.

| Reason                    | Retryable | Meaning                                                                  |
| ------------------------- | --------- | ------------------------------------------------------------------------ |
| `input-invalid`           | `false`   | the arguments fail the schema, or name a file or anchor no tool answers for |
| `tool-unknown`            | `false`   | no tool has that name                                                    |
| `path-escape`             | `false`   | the path lies outside every declared root                                |
| `path-ambiguous`          | `false`   | a relative path exists under more than one root; pass an absolute one    |
| `path-ignored`            | `false`   | the project's `ignoredPaths` excludes the file                           |
| `file-not-found`          | `false`   | the named file or anchor does not exist                                  |
| `no-module`               | `false`   | the path is in no Go module or npm package                               |
| `compile-db-missing`      | `false`   | `compile_commands.json` is missing or unreadable under `projectRoot`     |
| `compile-db-invalid`      | `false`   | `compile_commands.json` is not valid JSON or not a compile database      |
| `server-unavailable`      | `false`   | the language server or `clang-query` could not start; install it         |
| `symbol-not-found`        | `false`   | the index is proven ready and holds no such declaration                  |
| `symbol-ambiguous`        | `false`   | several declarations match and the server picks none; select one by kind |
| `symbol-kind-unsupported` | `false`   | the declaration's kind cannot answer this question                       |
| `not-ready`               | `true`    | readiness is not proven yet: a cold index or a workspace still loading   |
| `budget-exceeded`         | `true`    | the call's own time budget or ceiling ran out                            |
| `request-timeout`         | `true`    | the language server did not answer one request in time; it restarts     |
| `session-lost`            | `true`    | the language server restarted or died during the call                    |
| `cancelled`               | `true`    | the client cancelled the call                                            |
| `sweep-failed`            | `false`   | every translation unit of a `clang-query` sweep failed the same way      |
| `unexpected-answer`       | `false`   | the language server answered in a shape this server cannot read          |
| `internal`                | `false`   | a failure no reason above names; report it with its text                 |

The MCP SDK sends `input-invalid` and `tool-unknown` itself, before any tool runs, and attaches no `reason` to them; the
call log names them from their text. Any error without a `reason` is such a refusal of the request as sent: change the
request, do not retry it.

## What it saves

Measured on two real, private code bases (one Go, one C++): five questions, each put to two blind agents, one run per
agent. One agent had only `Read`, `Glob`, `Grep` and `Bash`; the other had the same plus the matching tool. Every answer
was checked against a hand-verified ground truth. Tokens are the whole run (input, cache and output), which includes a
fixed floor of about 190k from the harness itself, so the real difference in the work is larger than the percentages.

| Question                                          | Grep only                        | With the tool          | Tool calls | Tokens |
| ------------------------------------------------- | -------------------------------- | ---------------------- | ---------- | ------ |
| Go: where is a function declared                  | correct                          | correct                | 3 -> 2     | +1%    |
| Go: every use of a name                           | correct                          | correct                | 4 -> 3     | -19%   |
| Go: who calls a common method (9 callers)         | correct                          | correct                | 16 -> 2    | -78%   |
| C++: every use of a method (7 uses)               | 6 of 7, one use in a header missed | 7 of 7               | 12 -> 3    | -70%   |
| C++: who calls a virtual method (5 callers)       | 5 of 5 plus 2 false callers      | exact, no false caller | 22 -> 4    | -66%   |

Reading it: where one `grep` finds the answer (a declaration), the tool gains nothing. It pays for questions about
uses and callers, and in C++ it is the difference between a right and a wrong answer, because grep matches text:
the missed use and the two false callers are what text search does. The tool-call counts for the tool arm include the
step that loads the tool's schema.

The sample is small: five questions, two code bases, one run per arm, and the agents were Haiku-class. The TypeScript
tools have not been measured this way yet. Treat the table as an indication, not a benchmark, and measure on your own
code: the optional [call log](#call-log-and-privacy) records what each call cost.

## Trust model

Treat `projectRoot`, its `compile_commands.json` and its `mcp-code-nav.config.json` as trusted input: they are read,
and clangd and clang-query run with the flags the compile database names. Only open projects you would build. The
`ignoredPaths` patterns in the config are bounded (see [Project configuration](#project-configuration)) so a hostile
config cannot stall the server, but the compile database is not sandboxed.

## Limitations

- C++: answers come from clangd's index, so they are only as complete as that index. Right after start the index is
  still building, and the answer says so. `compile_commands.json` must come from a native build on the same host; a
  database from Docker, WSL or another OS names paths this host cannot open.
- C++ source sweeps skip VCS, build, vendored and agent-worktree directories (`.git`, `.claude`, `node_modules`, ...).
- Go: an answer covers only the module containing the named file, under the host's `GOOS`/`GOARCH`; a `go.work`
  beside it is reported, not spanned.
- TypeScript: needs the TypeScript 7 native server (`typescript@7`). Files that no `tsconfig` project
  includes (often tests) are not searched; the answer lists them under `scope.uncoveredSources`.
- Path containment against `sourceRoots` is checked twice: lexically, then on the real path with symlinks and
  junctions followed. A path that resolves through a link to a location outside every root is refused; add the link
  target to `sourceRoots` to read it. It guards against mistakes, not against a hostile caller; run the server only
  for clients you trust.
- There is no `outputSchema`; the structured payload shapes differ slightly per language.

## Cancellation, timeouts and server diagnostics

When the client cancels a tool call, the server cancels the language-server requests and helper processes it started
for that call. A request a language server leaves unanswered for 180 seconds is cancelled and fails with an error naming
the server and the method; set `MCP_CODE_NAV_REQUEST_TIMEOUT_MS` (a positive integer, at most 3600000) to change that,
for example for a workspace that is slow to index. A timeout also stops that language server and the next call on the
language starts a fresh one, so a cold re-index follows; a cancelled call leaves the server running.
A language server's stderr is read continuously and its last 8 KiB are appended to the error of a request that fails
because the server died or hung; an unexpected server exit is also written to this server's stderr.

## Language-server lifetime and resources

Each language server runs as one child process per root, started on first use. A child that receives no request for
10 minutes is stopped, and the next call on that root starts a fresh one; clangd's on-disk index under `.cache/clangd`
is kept, so the restart is cheap, but the fresh child is cold again and the answer says so while it indexes. At most 3
children per language server (clangd, gopls, TypeScript) run at once: starting one more stops the least recently used
one that has no request in flight and was not used in the last 30 seconds, and when every one is busy or recent the
limit is exceeded rather than a call refused; children beyond the limit are stopped 30 seconds after their last use.
Idle shutdown counts requests, not clangd's own background indexing: a project whose index takes longer than the idle
window without any request is stopped mid-index and resumes from the on-disk shards on the next call. The memory bound
takes precedence.

| Variable                      | Meaning                                                              | Default                      |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `MCP_CODE_NAV_IDLE_MS`        | idle time before a child is stopped; `0` never stops one             | `600000`                     |
| `MCP_CODE_NAV_MAX_SESSIONS`   | children per language server; `0` removes the limit                  | `3`                          |
| `MCP_CODE_NAV_CLANGD_JOBS`    | clangd's `-j` worker count (a positive integer)                      | half the cores, from 1 to 4  |

A value that is not a non-negative integer (a positive one for `MCP_CODE_NAV_CLANGD_JOBS`) is reported on stderr and
the default is used. clangd also starts with `--pch-storage=disk`; with a compile database its background index runs at
low priority (`--background-index-priority=low`), and without one there is no background index. clangd's reference
limit is off (`--limit-references=0`): its default of 1000 would cut a reference answer short without saying so.

## Call log and privacy

The call log is off by default. Set `MCP_CODE_NAV_CALL_LOG` to an absolute directory (for example
`~/.mcp-code-nav/calls`, spelled out as an absolute path) and the server writes one line per tool call there: the
tool name, outcome, timings, the paths and symbol names you passed as arguments, the client name and the server's
working directory. File contents are never logged, and the log stays on the local disk. `MCP_CODE_NAV_CALL_LOG=off`
is the same as unsetting it. `npm run stats` summarises the log in `MCP_CODE_NAV_CALL_LOG`, or in
`~/.mcp-code-nav/calls` when the variable is not set.

## Project configuration

`mcp-code-nav.config.json` in the `projectRoot` may hold `ignoredPaths`, glob patterns (matched against the path
relative to the root that contains the file) for files the C++ tools must not read. Because the patterns are matched
synchronously on every call and the file comes with the project, they are bounded: at most 100 patterns of at most
200 characters, with at most 6 `*`, at most 2 `{` (no `..` ranges inside braces) and at most 2 `(` each. A file that
breaks a limit is rejected as a whole with a message naming the rule.

## Development

```sh
npm ci
npm test
```

The gates, the live suite against the real language servers and how to report a problem are in
[WORKFLOW.md](docs/WORKFLOW.md). See also [CONTRIBUTING.md](CONTRIBUTING.md), [PRINCIPLES.md](docs/PRINCIPLES.md) (the
rules a change must keep) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE).
