/** Where the call log writes, from the environment the client launched this process with. */
import { isAbsolute } from "node:path";

/** `invalid` is a stated outcome, not a crash: a misconfigured value must not cost the caller its server. */
export type CallLogConfig =
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly dir: string }
  | { readonly kind: "invalid"; readonly value: string };

const ENV_VAR = "MCP_CODE_NAV_CALL_LOG";
const OFF = "off";

/**
 * Unset means off: the log records paths and symbol names, so a directory must be named to turn it on. That
 * directory must be absolute, because a relative one would mean whatever directory the client happened to
 * launch this server in.
 */
export function resolveCallLogConfig(env: NodeJS.ProcessEnv): CallLogConfig {
  const value = env[ENV_VAR];
  if (value === undefined || value === OFF) return { kind: "off" };
  return isAbsolute(value) ? { kind: "on", dir: value } : { kind: "invalid", value };
}
