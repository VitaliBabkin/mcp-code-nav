/**
 * Builds the single-file bundle (`dist-bundle/index.js`) with esbuild's JS API, baking the identity read from the
 * git tags into the artifact — as a `define`d constant the server reports over MCP and on stderr,
 * and as the `// MCPBUILD:` marker line that makes the identity readable in the file at rest.
 */
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { readIdentity } from "./build-identity.js";

const SERVER_NAME = "mcp-code-nav";
const BANNER_MARKER = `// MCPBUILD: ${SERVER_NAME}`;
const CREATE_REQUIRE = "import{createRequire as __codeNavCreateRequire}from 'module';const require=__codeNavCreateRequire(import.meta.url);";

/** The git-derived identity; a source archive without a git history is stamped with the package version instead. */
function resolveIdentity(): string {
  try {
    return readIdentity(process.cwd());
  } catch (error) {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    console.warn(`No git identity (${error instanceof Error ? error.message : String(error)}); using the package version.`);
    return `${manifest.version ?? "0.0.0"}+nogit`;
  }
}

const identity = resolveIdentity();

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  // jsonc-parser's `main` is a UMD build whose internal `require("./impl/...")` calls esbuild cannot follow.
  // This is a global resolution change, not a per-package one: it was checked against the current dependencies
  // (packages with `exports` ignore it) and the bundle smoke test guards the startup path.
  mainFields: ["module", "main"],
  outfile: "dist-bundle/index.js",
  banner: { js: `${BANNER_MARKER} ${identity}\n${CREATE_REQUIRE}` },
  define: { __MCP_CODE_NAV_BUILD__: JSON.stringify(identity) },
});

console.log(`Bundled ${SERVER_NAME} ${identity}`);
