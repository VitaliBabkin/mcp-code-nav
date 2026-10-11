import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { LspDocumentSymbol } from "../../src/clangd/outline.js";
import type { LspProcess } from "../../src/lsp/process.js";
import { LspSessionManager } from "../../src/lsp/session-manager.js";

type Connection = LspProcess["connection"];

/**
 * The server-to-client half of the protocol, unanswered. A real `MessageConnection` always has these
 * methods; a double without them makes `LspSession.ensureProcess` throw `onRequest is not a function`
 * before a single request is ever sent.
 */
export function noopServerHandlers(): Pick<Connection, "onRequest" | "onProgress"> {
  const dispose = { dispose: () => {} };
  return { onRequest: vi.fn(() => dispose), onProgress: vi.fn(() => dispose) } as unknown as Pick<
    Connection,
    "onRequest" | "onProgress"
  >;
}

/** A clangd whose `documentSymbol` answer is decided per file path; `null` reads as a cold, empty answer. */
export function fakeProcessByFile(byFile: (file: string) => LspDocumentSymbol[] | null): LspProcess {
  return fakeProcessByFileAndIndex(byFile);
}

/**
 * The same clangd, plus the project-wide symbol answer the unscoped branch uses. Asked of a
 * clangd that has not been given this half, `workspace/symbol` is an unexpected request — which is how the
 * suites that never reach the index prove they never reach it.
 */
export function fakeProcessByFileAndIndex(
  byFile: (file: string) => LspDocumentSymbol[] | null,
  indexRows?: (query: string) => unknown,
): LspProcess {
  return {
    connection: {
      sendRequest: vi.fn(async (method: string, params?: unknown) => {
        if (method === "initialize") return {};
        const document = params as { textDocument?: { uri: string } } | undefined;
        if (method === "textDocument/documentSymbol") {
          return byFile(fileURLToPath(document?.textDocument?.uri ?? ""));
        }
        if (method === "workspace/symbol") {
          if (indexRows === undefined) throw new Error(`unexpected request: ${method}`);
          return indexRows((params as { query?: string } | undefined)?.query ?? "");
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      sendNotification: vi.fn(async () => {}),
      ...noopServerHandlers(),
    } as unknown as Connection,
    isAlive: () => true,
    kill: () => {},
    spawnFailure: () => undefined,
  };
}

/**
 * A declaration whose own name sits at `nameLine`/`nameCharacter` (0-based, as the server counts) while its
 * whole range starts on column 0 of that line — the keyword. The two are deliberately apart so that a
 * request which landed on the range instead of the name is visible in the params it was sent with.
 */
export function symAt(name: string, kind: number, nameLine: number, nameCharacter: number): LspDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: nameLine, character: 0 }, end: { line: nameLine + 1, character: 1 } },
    selectionRange: {
      start: { line: nameLine, character: nameCharacter },
      end: { line: nameLine, character: nameCharacter + name.length },
    },
  };
}

export const sym = (name: string, kind: number): LspDocumentSymbol => ({
  name,
  kind,
  range: { start: { line: 0 }, end: { line: 1 } },
});

/** A session manager that hands out `clangd` and never sleeps between retries. */
export function sessionsFor(clangd: LspProcess): LspSessionManager {
  return new LspSessionManager({ spawn: () => clangd, sleep: async () => {} });
}
