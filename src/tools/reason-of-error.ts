import { CompileDbInvalidError, CompileDbNotFoundError } from "../clang-query/compile-db.js";
import type { ErrorReason } from "../error-reason.js";
import {
  RequestAbortedError,
  RequestTimeoutError,
  ServerExitedError,
} from "../lsp/request-control.js";
import { LanguageServerUnavailableError } from "../lsp/server-config.js";
import { AmbiguousRelativePathError, PathEscapeError } from "../paths/resolve-safe-path.js";
import { IgnoredPathError } from "./shared.js";

/** Longer than any wrapping this server does; a longer chain is treated as a cycle and read no further. */
const MAX_CAUSE_LINKS = 8;

/**
 * The reason a caught value names, read from its type. A wrapper that adds text to a failure keeps the failure as
 * `cause`, so the chain is read outward until a link names a reason; a chain that names none is `internal`.
 */
export function reasonOfError(error: unknown): ErrorReason {
  let link: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_LINKS && link !== undefined; depth++) {
    const reason = reasonOfLink(link);
    if (reason !== undefined) return reason;
    link = causeOf(link);
  }
  return "internal";
}

function reasonOfLink(error: unknown): ErrorReason | undefined {
  if (error instanceof PathEscapeError) return "path-escape";
  if (error instanceof AmbiguousRelativePathError) return "path-ambiguous";
  if (error instanceof IgnoredPathError) return "path-ignored";
  if (error instanceof CompileDbNotFoundError) return "compile-db-missing";
  if (error instanceof CompileDbInvalidError) return "compile-db-invalid";
  if (error instanceof LanguageServerUnavailableError) return "server-unavailable";
  if (error instanceof RequestTimeoutError) return "request-timeout";
  if (error instanceof RequestAbortedError) return "cancelled";
  if (error instanceof ServerExitedError) return "session-lost";
  if (codeOf(error) === "ENOENT") return "file-not-found";
  return undefined;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function causeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
}
