import { availableParallelism } from "node:os";
import { z } from "zod";

/** A session with no request for this long has its child disposed; `0` turns idle shutdown off. */
export const DEFAULT_IDLE_MS = 600_000;
/** Live sessions allowed per server kind before the least recently used idle one is disposed; `0` removes the cap. */
export const DEFAULT_MAX_SESSIONS = 3;

/**
 * A session used this recently is never a cap victim: one tool operation makes several session calls with gaps
 * between them, and a child taken away in a gap leaves the next call waiting on a process that is gone.
 */
export const EVICT_GRACE_MS = 30_000;

/** Reports a bad configuration value on stderr; stdout belongs to the protocol. */
export function warnOnStderr(message: string): void {
  process.stderr.write(`mcp-code-nav ${message}\n`);
}

const IDLE_ENV = "MCP_CODE_NAV_IDLE_MS";
const SESSIONS_ENV = "MCP_CODE_NAV_MAX_SESSIONS";
const JOBS_ENV = "MCP_CODE_NAV_CLANGD_JOBS";

/** The largest delay `setTimeout` honours; a longer one fires at once. */
const MAX_COUNT = 2_147_483_647;

const CountSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().max(MAX_COUNT));

/** How many live children the manager keeps, and for how long an unused one is kept. */
export interface SessionLimits {
  readonly idleMs: number;
  readonly maxSessions: number;
}

/**
 * A non-negative integer from the environment. Unset or empty means the default; anything else that is not
 * a plain integer is reported through `onInvalid` and the default is used, so a typo never costs the server.
 */
function readCount(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  onInvalid: (message: string) => void,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = CountSchema.safeParse(raw);
  if (parsed.success && parsed.data >= minimum) return parsed.data;
  const shape = minimum === 0 ? "a non-negative integer" : "a positive integer";
  onInvalid(
    `${name}="${raw}" is not ${shape} of at most ${String(MAX_COUNT)}; using ${String(fallback)}`,
  );
  return fallback;
}

/** The idle timeout and per-kind session cap; `0` disables the respective limit. */
export function resolveSessionLimits(
  env: NodeJS.ProcessEnv,
  onInvalid: (message: string) => void,
): SessionLimits {
  return {
    idleMs: readCount(env, IDLE_ENV, DEFAULT_IDLE_MS, 0, onInvalid),
    maxSessions: readCount(env, SESSIONS_ENV, DEFAULT_MAX_SESSIONS, 0, onInvalid),
  };
}

/** clangd's worker count: half the cores, at least one and at most four, unless the operator names one. */
export function resolveClangdJobs(
  env: NodeJS.ProcessEnv,
  onInvalid: (message: string) => void,
  cores: number = availableParallelism(),
): number {
  const fallback = Math.min(4, Math.max(1, Math.floor(cores / 2)));
  return readCount(env, JOBS_ENV, fallback, 1, onInvalid);
}
