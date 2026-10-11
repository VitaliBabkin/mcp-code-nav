import { resolve } from "node:path";
import type { DerivedClassMatch } from "./find-derived-classes.js";

/** One translation unit's contribution to a sweep — its matches, or the reason clang-query failed on it. */
export type TuOutcome =
  | { readonly kind: "matches"; readonly matches: readonly DerivedClassMatch[] }
  | { readonly kind: "failed"; readonly error: string };

interface ProjectEntry {
  fingerprint: string;
  queries: Map<string, Map<string, TuOutcome>>;
}

const EMPTY_TU_OUTCOMES: ReadonlyMap<string, TuOutcome> = new Map();

/**
 * Per-process store of sweep results, one entry per (projectRoot, qualifiedName, translation unit).
 * Lives as long as the server process, mirroring `LspSessionManager` in lifetime only — created in
 * `index.ts`, injected. Its key is `resolve`, not the session manager's case-folded `pathKey`, so on
 * Windows two spellings of one root that share a clangd session hold two cache entries (each re-sweeps
 * before it is trusted, so the divergence costs work and never a stale answer).
 * the project rules: a fingerprint mismatch on `lookup` drops the whole `projectRoot` entry (every query),
 * never serving an outcome the caller cannot prove current.
 */
export class SweepCache {
  private readonly projects = new Map<string, ProjectEntry>();

  /**
   * Cached outcomes for this query under `fingerprint`. A fingerprint mismatch drops the whole
   * `projectRoot` entry (every query) before returning empty.
   */
  lookup(projectRoot: string, qualifiedName: string, fingerprint: string): ReadonlyMap<string, TuOutcome> {
    const key = resolve(projectRoot);
    const project = this.projects.get(key);
    if (!project) return EMPTY_TU_OUTCOMES;
    if (project.fingerprint !== fingerprint) {
      this.projects.delete(key);
      return EMPTY_TU_OUTCOMES;
    }
    return project.queries.get(qualifiedName) ?? EMPTY_TU_OUTCOMES;
  }

  /** Records one TU's outcome. A TU interrupted by the time budget or a cancellation is never stored. */
  store(projectRoot: string, qualifiedName: string, fingerprint: string, tu: string, outcome: TuOutcome): void {
    const key = resolve(projectRoot);
    let project = this.projects.get(key);
    if (!project || project.fingerprint !== fingerprint) {
      project = { fingerprint, queries: new Map() };
      this.projects.set(key, project);
    }
    let tus = project.queries.get(qualifiedName);
    if (!tus) {
      tus = new Map();
      project.queries.set(qualifiedName, tus);
    }
    tus.set(tu, outcome);
  }

  clear(): void {
    this.projects.clear();
  }
}
