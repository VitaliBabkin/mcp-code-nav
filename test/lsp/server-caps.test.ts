import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clangdConfig,
  clangdNoDatabaseConfig,
  goplsConfig,
  type LanguageServerConfig,
  tsgoConfig,
} from "../../src/lsp/server-config.js";
import { CLANGD_SYMBOL_CAP_WATERMARK } from "../../src/tools/cpp-navigation-shared.js";
import { WORKSPACE_SYMBOL_CAP_WATERMARK } from "../../src/tools/go-find-symbol.js";
import { TS_WORKSPACE_SYMBOL_CAP_WATERMARK } from "../../src/tools/ts-find-symbol.js";

/**
 * How each request a session may send is kept from coming back silently truncated. A language server is free to
 * cut a list short without saying so, so every allowed request names its answer here: not a list, switched off by a
 * flag in the argv this server writes, detected by a watermark at or below the server's own cap, or measured
 * uncapped by a live test. A request added to an allow-list without an entry fails this file.
 */
type Handling =
  | { readonly kind: "not-a-list" }
  | { readonly kind: "flag"; readonly argv: string }
  | { readonly kind: "watermark"; readonly watermark: number; readonly serverCap: number }
  | { readonly kind: "measured"; readonly liveTest: string };

const NOT_A_LIST: Handling = { kind: "not-a-list" };

/** Requests whose answer is one position's item, one file's outline, or no list at all. */
const SINGLE_ANSWERS = {
  initialize: NOT_A_LIST,
  shutdown: NOT_A_LIST,
  "textDocument/documentSymbol": NOT_A_LIST,
  "textDocument/hover": NOT_A_LIST,
  "textDocument/definition": NOT_A_LIST,
  "textDocument/prepareCallHierarchy": NOT_A_LIST,
} as const;

const CLANGD_LIVE = "test/clangd/reference-limit.live.test.ts";
const GOPLS_LIVE = "test/gopls/result-caps.live.test.ts";
const TSGO_LIVE = "test/tsgo/result-caps.live.test.ts";

/** clangd's `--limit-results` default, which bounds `workspace/symbol` while the argv leaves it unset. */
const CLANGD_LIMIT_RESULTS_DEFAULT = 100;

const INVENTORY: Record<string, Readonly<Record<string, Handling>>> = {
  clangd: {
    ...SINGLE_ANSWERS,
    "textDocument/references": { kind: "flag", argv: "--limit-references=0" },
    "callHierarchy/incomingCalls": { kind: "measured", liveTest: CLANGD_LIVE },
    "workspace/symbol": {
      kind: "watermark",
      watermark: CLANGD_SYMBOL_CAP_WATERMARK,
      serverCap: CLANGD_LIMIT_RESULTS_DEFAULT,
    },
  },
  gopls: {
    ...SINGLE_ANSWERS,
    "textDocument/references": { kind: "measured", liveTest: GOPLS_LIVE },
    "textDocument/implementation": { kind: "measured", liveTest: GOPLS_LIVE },
    "callHierarchy/incomingCalls": { kind: "measured", liveTest: GOPLS_LIVE },
    "workspace/symbol": {
      kind: "watermark",
      watermark: WORKSPACE_SYMBOL_CAP_WATERMARK,
      serverCap: 100,
    },
  },
  tsgo: {
    ...SINGLE_ANSWERS,
    "textDocument/references": { kind: "measured", liveTest: TSGO_LIVE },
    "textDocument/implementation": { kind: "measured", liveTest: TSGO_LIVE },
    "callHierarchy/incomingCalls": { kind: "measured", liveTest: TSGO_LIVE },
    "workspace/symbol": {
      kind: "watermark",
      watermark: TS_WORKSPACE_SYMBOL_CAP_WATERMARK,
      serverCap: 256,
    },
  },
};

const TSGO = tsgoConfig({ executable: "tsc", version: "7.0.0", source: "global" });
const CONFIGS: readonly LanguageServerConfig[] = [
  clangdConfig,
  clangdNoDatabaseConfig,
  goplsConfig,
  TSGO,
];

describe.each(CONFIGS.map((config) => [config.sessionKind ?? config.id, config] as const))(
  "the %s session's result caps",
  (_, config) => {
    const inventory = INVENTORY[config.id] ?? {};
    const argv = config.argv("/root");

    it("names how every request it may send avoids a silently truncated list", () => {
      const unlisted = [...config.allowedRequests].filter(
        (method) => inventory[method] === undefined,
      );
      expect(unlisted).toEqual([]);
    });

    it.each([...config.allowedRequests])("%s is handled as the inventory says", (method) => {
      const handling = inventory[method];
      switch (handling?.kind) {
        case "flag":
          expect(argv).toContain(handling.argv);
          break;
        case "watermark":
          expect(handling.watermark).toBeLessThanOrEqual(handling.serverCap);
          break;
        case "measured":
          expect(existsSync(join(process.cwd(), handling.liveTest)), handling.liveTest).toBe(true);
          break;
        default:
          expect(handling).toEqual(NOT_A_LIST);
      }
    });
  },
);

describe("clangd's workspace/symbol cap", () => {
  it("stays at clangd's default, which the watermark is measured against", () => {
    expect(clangdConfig.argv("/root").some((arg) => arg.startsWith("--limit-results"))).toBe(false);
  });
});

describe("the inventory", () => {
  // The shared non-list entries are spread into every server; only a list-returning entry can go stale.
  it("handles no list request that no session of that server may send", () => {
    for (const [server, methods] of Object.entries(INVENTORY)) {
      const allowed = new Set(
        CONFIGS.filter((config) => config.id === server).flatMap((config) => [
          ...config.allowedRequests,
        ]),
      );
      const stale = Object.entries(methods)
        .filter(([method, handling]) => handling.kind !== "not-a-list" && !allowed.has(method))
        .map(([method]) => method);
      expect(stale, server).toEqual([]);
    }
  });
});
