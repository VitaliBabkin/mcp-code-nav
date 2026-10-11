import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The version this artifact was built as, for the MCP `serverInfo` and the startup line.
 *
 * `scripts/bundle.ts` substitutes it from the repository's release tags. A `tsc`/`tsx` run has no build step
 * to ask, so it reports the package version marked `+unbundled`.
 */
declare const __MCP_CODE_NAV_BUILD__: string | undefined;

const Manifest = z.object({ version: z.string().min(1) });

const UNKNOWN_IDENTITY = "0.0.0+unknown";

/**
 * `<version>+unbundled` from the `package.json` at `manifestUrl`, or `0.0.0+unknown` when it cannot be read:
 * the server must start whatever the manifest looks like.
 */
export function unbundledIdentity(manifestUrl: URL): string {
  try {
    const manifest = Manifest.parse(JSON.parse(readFileSync(manifestUrl, "utf8")));
    return `${manifest.version}+unbundled`;
  } catch {
    return UNKNOWN_IDENTITY;
  }
}

// `src/` and `dist/` both sit one level below the package root that holds `package.json`.
export const BUILD_IDENTITY =
  typeof __MCP_CODE_NAV_BUILD__ === "string"
    ? __MCP_CODE_NAV_BUILD__
    : unbundledIdentity(new URL("../package.json", import.meta.url));
