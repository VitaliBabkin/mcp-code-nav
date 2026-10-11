import { describe, expect, it } from "vitest";
import { TS_SOURCE_EXTENSIONS, isTsOrJsSourceFile, tsLanguageId } from "../../src/tsgo/language.js";
import { clangdConfig, goplsConfig, tsgoConfig } from "../../src/lsp/server-config.js";
import type { TsgoBinary } from "../../src/tsgo/binary.js";

/**
 * The LSP `languageId` a TS/JS document is opened under. One tsgo process answers both
 * families, so the id follows the file's extension and a `.tsx` opened as `typescript` would be parsed as
 * TypeScript without JSX — a wrong answer about the file, not a different spelling of the right one.
 */

/** The id each accepted extension is told, which `tsLanguageId` is expected to state. */
const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

describe("tsLanguageId", () => {
  it.each([
    ["index.ts", "typescript"],
    ["index.mts", "typescript"],
    ["index.cts", "typescript"],
    ["App.tsx", "typescriptreact"],
    ["legacy.js", "javascript"],
    ["legacy.mjs", "javascript"],
    ["legacy.cjs", "javascript"],
    ["List.jsx", "javascriptreact"],
  ])("opens %s as %s", (file: string, languageId: string) => {
    expect(tsLanguageId(file)).toBe(languageId);
  });

  it("opens a declaration file as TypeScript, because the extension it ends in is .ts", () => {
    expect(tsLanguageId("a.d.ts")).toBe("typescript");
    expect(tsLanguageId("react/v16.d.ts")).toBe("typescript");
  });

  it("decides the id from the extension whatever case it is spelled in", () => {
    expect(tsLanguageId("A.TSX")).toBe("typescriptreact");
    expect(tsLanguageId("Component.Ts")).toBe("typescript");
  });

  it("opens a path whose extension is outside the accepted set as TypeScript, the fallback tsgo itself assumes", () => {
    expect(tsLanguageId("notes.md")).toBe("typescript");
    expect(tsLanguageId("bundle")).toBe("typescript");
    expect(tsLanguageId("main.go")).toBe("typescript");
  });
});

describe("isTsOrJsSourceFile", () => {
  it("accepts every extension in TS_SOURCE_EXTENSIONS", () => {
    for (const extension of TS_SOURCE_EXTENSIONS) {
      expect(isTsOrJsSourceFile(`a${extension}`), `accepted list should answer true for ${extension}`).toBe(true);
    }
  });

  it.each([
    ["package.json", "a manifest, not a source"],
    ["styles.css", "a stylesheet"],
    ["main.py", "another language's source"],
    ["README", "a path with no extension at all"],
  ])("refuses %s, which is %s", (file: string, _why: string) => {
    expect(isTsOrJsSourceFile(file)).toBe(false);
  });

  it("refuses a directory anchor whose name carries no extension", () => {
    expect(isTsOrJsSourceFile("src/components")).toBe(false);
  });

  it("accepts an extension whatever case it is spelled in", () => {
    expect(isTsOrJsSourceFile("A.TS")).toBe(true);
    expect(isTsOrJsSourceFile("List.JsX")).toBe(true);
  });
});

describe("TS_SOURCE_EXTENSIONS", () => {
  it("is exactly the eight TypeScript and JavaScript extensions this backend answers for", () => {
    expect(TS_SOURCE_EXTENSIONS).toHaveLength(8);
    expect([...TS_SOURCE_EXTENSIONS].sort()).toEqual(Object.keys(LANGUAGE_IDS).sort());
  });

  it("maps every extension it lists through tsLanguageId to the id this test expects of it", () => {
    for (const extension of TS_SOURCE_EXTENSIONS) {
      const expected = LANGUAGE_IDS[extension];
      expect(expected, `${extension} is listed but has no expected id to compare against`).not.toBeUndefined();
      expect(tsLanguageId(`a${extension}`)).toBe(expected);
    }
  });

  it("lists only extensions whose id is one of the four tsgo is told", () => {
    const ids = new Set(Object.values(LANGUAGE_IDS));
    for (const extension of TS_SOURCE_EXTENSIONS) {
      expect(ids.has(tsLanguageId(`a${extension}`)), `${extension} maps outside the four ids`).toBe(true);
    }
  });
});

describe("the languageId a session opens a TS document under", () => {
  const BINARY: TsgoBinary = { executable: "/native/typescript-linux-x64/lib/tsc", version: "7.0.2", source: "global" };

  it("comes from tsLanguageId for tsgo, whose one process serves both families", () => {
    const config = tsgoConfig(BINARY);

    expect(config.id).toBe("tsgo");
    expect(config.languageIdFor("App.tsx")).toBe("typescriptreact");
    expect(config.languageIdFor("index.mjs")).toBe("javascript");
    expect(config.languageIdFor("a.d.ts")).toBe("typescript");
  });

  it("stays a constant for the servers that answer for one language", () => {
    expect(clangdConfig.languageIdFor("App.tsx")).toBe("cpp");
    expect(clangdConfig.languageIdFor("main.cpp")).toBe("cpp");
    expect(goplsConfig.languageIdFor("a.go")).toBe("go");
    expect(goplsConfig.languageIdFor("main.go")).toBe("go");
  });
});
