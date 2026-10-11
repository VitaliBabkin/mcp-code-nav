/**
 * The server `instructions` string, sent to every session that connects.
 *
 * It is capped at 2,000 chars because a client harness has been observed truncating at ~2,048, and
 * the parts are ordered so a truncating client loses per-language detail before it loses the naming rule and
 * the tool map. To re-measure what a model actually receives, diff a fresh session's system prompt against
 * this string; the pin in `test/server-instructions.test.ts` is what stops it regrowing.
 */

import { READ_ONLY_CLANGD_SENTENCE } from "./tools/shared.js";

/** every tool name carries its language prefix - no asymmetry left to call out. */
export const LANGUAGE_RULE = "A tool's language is in its name: `cpp_`, `go_` or `ts_`.";

const TOOL_ROUTING =
  "File outline: cpp_file_symbols / go_file_symbols / ts_file_symbols. Where a name is declared: " +
  "cpp_find_symbol / go_find_symbol / ts_find_symbol. Every use of a symbol: cpp_find_references / " +
  "go_find_references / ts_find_references. Who calls a function: cpp_find_callers / go_find_callers / " +
  "ts_find_callers. Who derives from a C++ class, transitively or direct-only: cpp_find_derived_classes - " +
  "always, never a single-level guess, which provably misses grandchildren. Who implements a Go interface, " +
  "or what a Go type implements: go_find_implementations, or a TypeScript interface or class: " +
  "ts_find_implementations. Every answer read from an index or type checker states in `scope` what it could " +
  "not see.";

const CPP_INSTRUCTIONS =
  "C++ tools run clangd and clang-query on one `projectRoot`, the build directory holding compile_commands.json " +
  "from a native build on this host (`sourceRoots` defaults to its source tree): a database from Docker, WSL or " +
  "another OS names paths this host cannot open, so cpp_find_derived_classes fails and the clangd tools degrade " +
  "without saying so - use grep there.";

const GO_INSTRUCTIONS =
  "Go tools are read-only and need `gopls` on PATH (or MCP_CODE_NAV_GOPLS set to its absolute path) and a Go " +
  "module on this host. An answer covers only the module of the path you name, under this host's GOOS/GOARCH; " +
  "a `go.work` beside it is reported, not spanned, and `scope.osArchExcluded` sees filename exclusions only, " +
  "never `//go:build` lines.";

const TS_INSTRUCTIONS =
  "TS tools need the TypeScript 7 native server (global `typescript@7`, or MCP_CODE_NAV_TSGO set to its " +
  "executable) and answer for the npm workspace holding the path you name; files no tsconfig project " +
  "includes, often tests, are not searched: an answer whose `scope.uncoveredSources.mentioning` lists files is " +
  "incomplete until you grep them.";

export const SERVER_INSTRUCTIONS = [
  LANGUAGE_RULE,
  TOOL_ROUTING,
  `${CPP_INSTRUCTIONS} ${READ_ONLY_CLANGD_SENTENCE}`,
  GO_INSTRUCTIONS,
  TS_INSTRUCTIONS,
].join(" ");
