#!/usr/bin/env python3
"""Pre-push entry point of mcp-code-nav (~/.ai/rules/pre-push-gate.md).

Run by the global pre-push hook from the repository root as `pre_push_gate.py <remote-name> <remote-url>` with git's
pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line). The hook knows only this path and the
exit codes; everything about the repository lives here.

  0  pass: the push carries no branch commits (a tag, a deletion), changes no gate input, or every step is green
  1  violation (blocks): a step is red
  2  cannot measure (blocks): no toolchain, the working copy is not what is pushed, the install is missing, or the
     pushed range cannot be read; the message says what to do

Steps mirror .github/workflows/ci.yml: the gate's own tests, `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`. The live suite (`npm run test:live`) stays out: it needs real language servers.
The run stops at the first red step. The gate never installs.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BRANCH = "main"

# Paths that feed no step. Everything else is a gate input: docs, Markdown, .github and .claude are read by the test
# suite (no-internal-references) or the formatter.
NON_INPUT_FILES = frozenset({".qwenignore", "LICENSE"})


class CannotMeasure(RuntimeError):
    """The gate cannot produce a verdict - exit 2."""


class Push(NamedTuple):
    """One pushed branch update: the remote ref it names, the local commit it sends, the remote commit it replaces
    (zeros for a new ref)."""

    ref: str
    sha: str
    remote_sha: str


def is_zero(sha: str) -> bool:
    return set(sha) == {"0"}


def git_lines(*args: str) -> list[str] | None:
    """Output lines of a git command in the repo, or None when git refused (e.g. an object it does not have)."""
    done = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "-c", "core.quotepath=false", *args],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return [line for line in done.stdout.splitlines() if line.strip()] if done.returncode == 0 else None


def pushed_branches(stdin_lines: Iterable[str]) -> list[Push]:
    """Every pushed branch update that carries commits; a deletion and a tag update never reach the gate. The remote
    ref decides: `HEAD:refs/tags/v1` updates a tag, `v1:refs/heads/x` a branch."""
    pushed = []
    for line in stdin_lines:
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 4:
            raise CannotMeasure(f"unreadable pre-push stdin line {line!r}: expected <ref> <oid> <ref> <oid>")
        if not is_zero(parts[1]) and not parts[2].startswith("refs/tags/"):
            pushed.append(Push(parts[2], parts[1], parts[3]))
    return pushed


def check_working_copy_is_pushed(branches: Sequence[Push]) -> None:
    """The gate measures the working copy, so it must be what is pushed (contract rule 6). Untracked files count: a
    test scans the tree, not the commit."""
    head = (git_lines("rev-parse", "HEAD") or [""])[0]
    for push in branches:
        if push.sha != head:
            raise CannotMeasure(
                f"'{push.ref}' pushes {push.sha[:12]}, the working copy is at {head[:12]}: check the branch out "
                f"(git switch) and push it, the gate measures the working copy"
            )
    listed = git_lines("status", "--porcelain", "--untracked-files=all")
    if listed is None:
        raise CannotMeasure("git status failed: cannot tell whether the working copy is what is pushed")
    status = [line for line in listed if touches_gate_input(status_paths(line))]
    if status:
        raise CannotMeasure(
            "uncommitted or untracked files, the measurement would not be of what is pushed - "
            "commit, stash or ignore them:\n  " + "\n  ".join(status[:10])
        )


def status_paths(line: str) -> list[str]:
    """The paths of one `git status --porcelain` line (`XY path`, or `XY old -> new` for a rename)."""
    return line[3:].strip('"').split(" -> ")


def changed_paths_args(remote: str, push: Push) -> list[list[str]]:
    """git argument lists whose output, together, is every file the push changes. The endpoint diff alone misses a
    file that a commit of the range changes and a later one restores, so the commits' own file lists join it (-m lists
    a merge's changes against each parent). A new ref has no endpoint: its commits are the ones no remote-tracking ref
    of `remote` has yet."""
    if is_zero(push.remote_sha):
        return [["log", "-m", "--no-renames", "--name-only", "--format=", push.sha, "--not", f"--remotes={remote}"]]
    return [
        ["diff", "--no-renames", "--name-only", push.remote_sha, push.sha],
        ["log", "-m", "--no-renames", "--name-only", "--format=", f"{push.remote_sha}..{push.sha}"],
    ]


def changed_paths(remote: str, push: Push) -> list[str]:
    paths: set[str] = set()
    for args in changed_paths_args(remote, push):
        listed = git_lines(*args)
        if listed is None:
            raise CannotMeasure(
                f"git {' '.join(args)} failed: the pushed range cannot be read here (is the remote fetched?)"
            )
        paths.update(listed)
    return sorted(paths)


def is_gate_input(path: str) -> bool:
    return path not in NON_INPUT_FILES


def touches_gate_input(paths: Iterable[str]) -> bool:
    return any(is_gate_input(path) for path in paths)


def check_install(npm: str) -> None:
    """The gate never installs: a missing, partial or lockfile-stale node_modules (`npm ls --all` rejects it) is exit 2
    with the command that fixes it."""
    if not (REPO_ROOT / "node_modules").is_dir():
        raise CannotMeasure("node_modules is not installed: run `npm ci`")
    listing = subprocess.run(
        [npm, "ls", "--all"], cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    )
    if listing.returncode != 0:
        raise CannotMeasure("npm ls --all reports missing, extraneous or invalid packages: run `npm ci`")


def steps(npm: str) -> list[tuple[str, list[str]]]:
    """(name, command) in the order CI runs them; every command runs at the repository root."""
    return [
        ("gate tests", [sys.executable, "-B", "-m", "unittest", "tools/ci/test_pre_push_gate.py"]),
        ("format:check", [npm, "run", "format:check"]),
        ("lint", [npm, "run", "lint"]),
        ("typecheck", [npm, "run", "typecheck"]),
        ("test", [npm, "test"]),
    ]


def run_steps(steps_to_run: Sequence[tuple[str, list[str]]]) -> int:
    """Runs each step at the repository root; the first red one is reported and stops the run with 1."""
    for name, command in steps_to_run:
        print(f"pre_push_gate: {name}", flush=True)
        if subprocess.run(command, cwd=REPO_ROOT, check=False).returncode != 0:
            print(f"pre_push_gate: {name} is red (see above)", file=sys.stderr)
            return 1
    return 0


def run_gate() -> int:
    npm = shutil.which("npm")
    if not npm or not shutil.which("node"):
        raise CannotMeasure("node or npm not on PATH: install the Node version named by engines.node in package.json")
    check_install(npm)
    return run_steps(steps(npm))


def main() -> int:
    remote = sys.argv[1] if len(sys.argv) > 1 else "origin"
    try:
        branches = pushed_branches(sys.stdin.buffer.read().decode("utf-8", errors="replace").splitlines())
        if not branches:
            print("pre_push_gate: no branch with commits in the push, nothing to measure")
            return 0
        if not any(touches_gate_input(changed_paths(remote, push)) for push in branches):
            print("pre_push_gate: the push changes no gate input, nothing to measure")
            return 0
        check_working_copy_is_pushed(branches)
        code = run_gate()
        check_working_copy_is_pushed(branches)  # a step that rewrote a file measured something other than the push
        return code
    except (CannotMeasure, OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
        print(f"pre_push_gate: cannot measure: {exc or type(exc).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
