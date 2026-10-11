import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collapseLineBreaks } from "../helpers/markdown.js";
import { textDocumentId } from "../../src/lsp/document-uri.js";
import { LspSession } from "../../src/lsp/session.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";
import { clangdConfig } from "../../src/lsp/server-config.js";
import { runCppFindSymbol } from "../../src/tools/cpp-find-symbol.js";

// clangd is optional on this host in exactly the way gopls is, so the suite skips rather than failing with
// the symptom it exists to detect. `MCP_CODE_NAV_CLANGD` overrides, as it does at runtime.
function isClangdAvailable(): boolean {
  try {
    execFileSync(process.env.MCP_CODE_NAV_CLANGD ?? "clangd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const itIfClangd = isClangdAvailable() ? it : it.skip;

/**
 * A class template with an out-of-line member, an explicit specialization of that member, and a call that
 * forces an instantiation. `cpp_find_symbol`'s description is clangd's own `textDocument/hover`
 * rendering, so what a template's rendering actually contains — the `template <class T>` header, a
 * specialization's `template <>` header, and whether the primary's member can be told from a specialized
 * one — is a fact about the binary that no hand-written outline can supply.
 *
 * 1-based lines as written below.
 */
const HOLDER_H = [
  "#pragma once", //                       1
  "", //                                  2
  "namespace gizmo {", //                  3
  "", //                                  4
  "/// Holds a value of the type it was given.", //  5
  "template <class T>", //                 6
  "class Holder {", //                     7
  "public:", //                            8
  "  /// The stored value.", //            9
  "  T value() const;", //                 10
  "", //                                 11
  "  T stored;", //                       12
  "};", //                                13
  "", //                                 14
  "/// The integral case, rounded.", //   15
  "template <>", //                       16
  "class Holder<int> {", //               17
  "public:", //                           18
  "  int value() const;", //              19
  "  int stored;", //                     20
  "};", //                                21
  "", //                                 22
  "template <class T>", //                23
  "T Holder<T>::value() const {", //      24
  "  return stored;", //                  25
  "}", //                                 26
  "", //                                 27
  "template <>", //                       28
  "int Holder<int>::value() const {", //  29
  "  return stored + 1;", //              30
  "}", //                                 31
  "", //                                 32
  "}  // namespace gizmo", //             33
  "", //                                 34
].join("\n");

/** Two call sites that force two instantiations, one of the primary and one of the specialization. */
const USE_CPP = [
  '#include "holder.h"', //                     1
  "", //                                      2
  "int use(gizmo::Holder<double> &h) {", //    3
  "  return static_cast<int>(h.value());", //  4
  "}", //                                      5
  "", //                                      6
  "int useInt(gizmo::Holder<int> &h) {", //    7
  "  return h.value();", //                    8
  "}", //                                      9
  "", //                                     10
].join("\n");

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface HoverPayload {
  name: string;
  kind: string;
  file: string;
  range: { startLine: number; endLine: number };
  signature?: string;
  documentation?: string;
  descriptionUnavailable?: string;
}

const textOf = (result: { content: readonly { text?: string }[] }): string => result.content[0]?.text ?? "";

const payloadOf = (result: { structuredContent?: unknown; isError?: boolean }): HoverPayload => {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as HoverPayload;
};

describe("a template declaration's description against a real clangd binary", () => {
  let projectRoot: string;
  let header: string;
  let source: string;
  const managers: LspSessionManager[] = [];
  const sessions: LspSession[] = [];

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mcp-code-nav-template-live-"));
    header = join(projectRoot, "holder.h");
    source = join(projectRoot, "use.cpp");
    writeFileSync(header, HOLDER_H);
    writeFileSync(source, USE_CPP);
    writeFileSync(
      join(projectRoot, "compile_commands.json"),
      JSON.stringify([
        { directory: projectRoot, command: "clang++ -std=c++17 -c use.cpp -o use.o", file: "use.cpp" },
        { directory: projectRoot, command: "clang++ -std=c++17 -fsyntax-only holder.h", file: header },
      ]),
    );
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    while (managers.length > 0) managers.pop()?.disposeAll();
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
        return;
      } catch {
        if (attempt >= 9) throw new Error(`could not remove ${projectRoot}`);
        await sleep(300);
      }
    }
  });

  function freshManager(): LspSessionManager {
    const manager = new LspSessionManager();
    managers.push(manager);
    return manager;
  }

  function bareSession(): LspSession {
    const session = new LspSession({ root: projectRoot, config: clangdConfig });
    sessions.push(session);
    return session;
  }

  /** clangd's answer at one position, exactly as it arrives. */
  async function rawHover(session: LspSession, file: string, line: number, character: number): Promise<unknown> {
    await session.documentSymbol(file);
    return session.request<unknown>("textDocument/hover", {
      textDocument: textDocumentId(file),
      position: { line, character },
    });
  }

  const asked = (name: string) => runCppFindSymbol(freshManager(), { projectRoot, name, file: "holder.h" } as never);

  itIfClangd("carries the template header in the primary template's own rendering", async () => {
    const found = payloadOf(await asked("Holder"));

    expect(found).toMatchObject({ name: "gizmo::Holder", kind: "class", file: header, range: { startLine: 7 } });
    // The prose is compared with line breaks collapsed on both sides: clangd 18 separates its parts with a hard break,
    // later releases with a blank line.
    // Verbatim, because the rendering is the answer: the parameter list is part of what clangd shows, and
    // the prose keeps the size line only for a type whose layout is fixed — a primary template's is not.
    expect(found.signature).toBe("// In namespace gizmo\ntemplate <class T> class Holder {}");
    expect(collapseLineBreaks(found.documentation)).toBe(
      collapseLineBreaks("### class `Holder`\n\n---\nHolds a value of the type it was given.\n\n---"),
    );
    expect(found.descriptionUnavailable).toBeUndefined();
  }, 30_000);

  itIfClangd("describes a template's member as the member of the uninstantiated primary", async () => {
    const found = payloadOf(await asked("Holder::value"));

    expect(found).toMatchObject({
      name: "gizmo::Holder::value",
      kind: "method",
      file: header,
      range: { startLine: 10 },
    });
    // `// In Holder<T>` is clangd saying whose member this is while it is still unspecialised, and the
    // return arrow is its rendering of the signature's result — the return type is the template parameter.
    expect(found.signature).toBe("// In Holder<T>\npublic: T value() const");
    expect(collapseLineBreaks(found.documentation)).toBe(
      collapseLineBreaks("### instance-method `value`\n\n---\n→ `T`\n\nThe stored value.\n\n---"),
    );
    expect(found.descriptionUnavailable).toBeUndefined();
  }, 30_000);

  itIfClangd("keeps an explicit specialization a separate declaration, named with its argument list", async () => {
    const found = payloadOf(await asked("Holder<int>"));

    // The outline entry begins on the `template <>` line, not the `class` line, so the range this server
    // reports for a specialization starts one row earlier than a reader might expect — and the name keeps
    // `<int>`, which is what distinguishes it from the primary at the same spelling.
    expect(found).toMatchObject({ name: "gizmo::Holder<int>", kind: "class", file: header, range: { startLine: 16 } });
    expect(found.signature).toBe("// In namespace gizmo\ntemplate <> class Holder<int> {}");
    expect(collapseLineBreaks(found.documentation)).toBe(
      collapseLineBreaks("### class `Holder<int>`\n\n---\nSize: 4 bytes, alignment 4 bytes\n\nThe integral case, rounded.\n\n---"),
    );
  }, 30_000);

  itIfClangd("describes a specialized member beside the primary's, and never conflates the two", async () => {
    const specialized = payloadOf(await asked("Holder<int>::value"));
    const primary = payloadOf(await asked("gizmo::Holder::value"));

    expect(specialized).toMatchObject({ name: "gizmo::Holder<int>::value", kind: "method", range: { startLine: 19 } });
    expect(specialized.signature).toBe("// In Holder<int>\npublic: int value() const");
    // The specialization's member carries no doc comment, so the prose is clangd's own result line and
    // nothing more: no invented documentation.
    expect(collapseLineBreaks(specialized.documentation)).toBe(
      collapseLineBreaks("### instance-method `value`\n\n---\n→ `int`\n\n---"),
    );
    expect(primary.name).toBe("gizmo::Holder::value");
    expect(primary.signature).toBe("// In Holder<T>\npublic: T value() const");
  }, 30_000);

  itIfClangd("answers a call on an instantiation with the substituted member it reached", async () => {
    const session = bareSession();
    const answer = (await rawHover(session, source, 7, 12)) as { contents: { kind: string; value: string } };

    // At `h.value()` where `h` is `Holder<int> &`, clangd names the primary's member, reports where it came
    // from, and renders it substituted to `int`. This is the description of a call site, not of a
    // declaration — which is why `cpp_find_symbol` asks at a declaration's own identifier instead.
    expect(answer.contents.kind).toBe("markdown");
    expect(collapseLineBreaks(answer.contents.value)).toBe(
      collapseLineBreaks(
        "### instance-method `value`\n\nprovided by `\"holder.h\"`\n\n---\n→ `int`\n\n---\n" +
          "```cpp\n// In Holder<int>\npublic: int value() const\n```",
      ),
    );
  }, 30_000);
});
