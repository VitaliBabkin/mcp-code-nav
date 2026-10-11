import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clangdConfig, goplsConfig } from "../../src/lsp/server-config.js";
import { fakeServer, sessionOver, uriOf } from "../helpers/fake-lsp.js";
import { sym } from "../helpers/fake-clangd.js";

const DECLARED = sym("PgStorage", 23);

// Windows spells one path in two cases and `pathKey` is what equates them; elsewhere the case would not
// be the thing under test, so the case that needs it is skipped rather than passed vacuously.
const itIfCaseInsensitive = process.platform === "win32" ? it : it.skip;

const neverWalk = { ...goplsConfig, moduleSnapshot: () => new Map<string, string>() };

function running(): { server: ReturnType<typeof fakeServer>; session: ReturnType<typeof sessionOver> } {
  const server = fakeServer({ respond: () => [DECLARED] });
  return { server, session: sessionOver(server, { config: neverWalk }) };
}

describe("LspSession.documentSymbolTransient", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  });

  it("opens, reads and closes the file, in that order, and keeps nothing open", async () => {
    const { server, session } = running();
    expect(await session.documentSymbolTransient("/mod/pg.go")).toEqual([DECLARED]);
    expect(server.journal).toEqual([
      "req:initialize",
      "note:initialized",
      "note:textDocument/didOpen",
      "req:textDocument/documentSymbol",
      "note:textDocument/didClose",
    ]);
    expect(session.getOpenedFiles()).toEqual([]);
  });

  it("leaves no trace in the opened set, so a second transient read re-opens the file", async () => {
    const { server, session } = running();
    await session.documentSymbolTransient("/mod/pg.go");
    await session.documentSymbolTransient("/mod/pg.go");
    expect(server.notifications.filter(([method]) => method === "textDocument/didOpen")).toHaveLength(2);
    expect(server.notifications.filter(([method]) => method === "textDocument/didClose")).toHaveLength(2);
  });

  it("does not close a file the session holds open for good, and does not re-open it", async () => {
    const { server, session } = running();
    await session.documentSymbol("/mod/a.go");
    const before = server.journal.length;

    await session.documentSymbolTransient("/mod/a.go");

    expect(server.journal.slice(before)).toEqual(["req:textDocument/documentSymbol"]);
    expect(session.getOpenedFiles()).toEqual(["/mod/a.go"]);
  });

  it("still closes the file when the read itself failed, and reports the failure", async () => {
    const server = fakeServer({
      respond: (method) => {
        if (method === "textDocument/documentSymbol") throw new Error("gopls refused the outline");
        return {};
      },
    });
    const session = sessionOver(server, { config: neverWalk });
    await expect(session.documentSymbolTransient("/mod/pg.go")).rejects.toThrow("gopls refused the outline");
    expect(server.notifications.filter(([method]) => method === "textDocument/didClose")).toHaveLength(1);
    expect(session.getOpenedFiles()).toEqual([]);
  });

  it("names the document by URI, the same way every other route does", async () => {
    const { server, session } = running();
    await session.documentSymbolTransient("/mod/pg.go");
    const didOpen = server.notifications.find(([method]) => method === "textDocument/didOpen");
    expect(didOpen?.[1]).toMatchObject({ textDocument: { uri: uriOf("/mod/pg.go"), languageId: "go" } });
  });

  itIfCaseInsensitive("asks about a re-spelled path with the URI the document was opened under", async () => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-code-nav-spell-"));
    const written = join(tmp, "a.go");
    writeFileSync(written, "package a\n");
    const recased = join(tmp, "A.GO");
    const server = fakeServer({ respond: () => [DECLARED] });
    const session = sessionOver(server, { root: tmp, config: neverWalk, readFile: () => "package a\n" });

    await session.documentSymbol(written);
    await session.documentSymbol(recased);

    const didOpens = server.notifications.filter(([method]) => method === "textDocument/didOpen");
    expect(didOpens).toHaveLength(1);
    const requests = server.requests.filter(([method]) => method === "textDocument/documentSymbol");
    expect(requests).toHaveLength(2);
    const uriOfRequest = (params: unknown): unknown =>
      (params as { textDocument: { uri: string } }).textDocument.uri;
    // The second call named the same file with another spelling: it must ask about the document the
    // server was given, not about a URI no `didOpen` ever carried.
    expect(uriOfRequest(requests[0]?.[1])).toBe(uriOf(written));
    expect(uriOfRequest(requests[1]?.[1])).toBe(uriOf(written));
  });
});
