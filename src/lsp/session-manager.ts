import { resolve } from "node:path";
import { noteSession } from "../call-log/annotations.js";
import { pathKey } from "../paths/path-containment.js";
import type { LanguageServerConfig } from "./server-config.js";
import { LspSession, type LspSessionOptions } from "./session.js";

/** One `LspSession` per `(server kind, resolved root)`, created lazily on first use. */
export class LspSessionManager {
  private readonly sessions = new Map<string, LspSession>();

  constructor(private readonly sessionOptions: Omit<LspSessionOptions, "root" | "config"> = {}) {}

  /**
   * The key is `pathKey`, not `resolve`: two spellings of one root would otherwise start two
   * children, each paying its own cold load. The session keeps `resolve`'s
   * original-case path, which is what the child and its URIs are built from.
   */
  get(root: string, config: LanguageServerConfig): LspSession {
    const key = `${config.sessionKind ?? config.id}\0${pathKey(root)}`;
    let session = this.sessions.get(key);
    const created = session === undefined;
    if (session === undefined) {
      session = new LspSession({ ...this.sessionOptions, root: resolve(root), config });
      this.sessions.set(key, session);
    }
    noteSession(created);
    return session;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
