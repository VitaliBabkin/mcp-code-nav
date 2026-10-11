# mcp-code-nav

An [MCP](https://modelcontextprotocol.io) server that gives an AI coding agent compiler-grade code navigation instead of
grep: file outlines, where a name is declared, every reference to a symbol, who calls a function, and who implements an
interface or derives from a class. It drives real language servers behind one stdio server:

| Language   | Backend                                         | Tools                                                                                                              |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C++        | `clangd` and `clang-query`                      | `cpp_file_symbols`, `cpp_find_symbol`, `cpp_find_references`, `cpp_find_callers`, `cpp_find_derived_classes`       |
| Go         | `gopls`                                         | `go_file_symbols`, `go_find_symbol`, `go_find_references`, `go_find_callers`, `go_find_implementations`            |
| TypeScript | the TypeScript 7 native server (`typescript@7`) | `ts_file_symbols`, `ts_find_symbol`, `ts_find_references`, `ts_find_callers`, `ts_find_implementations`            |

Every answer says what it could **not** see (a `scope` block: files no project includes, an index that is still
warming up, a module boundary, and so on) instead of presenting a partial result as complete. The server never writes to
your sources.

## Requirements

- Node.js 20 or newer.
- The language servers for the languages you want. Each is optional; a tool whose server is missing returns an error that
  says how to install it. The servers are looked up like this:

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

## Register it in an MCP client

The server speaks MCP over stdio. For a client that uses the common `mcpServers` JSON format:

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
for the Go and TypeScript tools, an optional `timeBudgetMs`. The C++ tools take a `projectRoot` instead (the build
directory with `compile_commands.json`) and `sourceRoots` defaults to its source tree.

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
[WORKFLOW.md](WORKFLOW.md). See also [CONTRIBUTING.md](CONTRIBUTING.md), [PRINCIPLES.md](PRINCIPLES.md) (the rules a
change must keep) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE).
