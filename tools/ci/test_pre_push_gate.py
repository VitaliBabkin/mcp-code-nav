"""Tests of the pre-push gate's pure logic: stdin parsing, the pushed-range arguments and the gate-input filter."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pre_push_gate as gate  # noqa: E402

ZERO = "0" * 40
A = "a" * 40
B = "b" * 40


class PushedBranches(unittest.TestCase):
    def test_branch_update_is_parsed(self) -> None:
        line = f"refs/heads/feat {A} refs/heads/feat {B}"
        self.assertEqual(gate.pushed_branches([line]), [gate.Push("refs/heads/feat", A, B)])

    def test_new_ref_keeps_zero_remote_sha(self) -> None:
        pushed = gate.pushed_branches([f"refs/heads/x {A} refs/heads/x {ZERO}"])
        self.assertEqual(pushed, [gate.Push("refs/heads/x", A, ZERO)])

    def test_deletion_is_skipped(self) -> None:
        self.assertEqual(gate.pushed_branches([f"(delete) {ZERO} refs/heads/x {B}"]), [])

    def test_tag_update_is_skipped_even_from_a_local_branch(self) -> None:
        self.assertEqual(gate.pushed_branches([f"HEAD {A} refs/tags/v1 {ZERO}"]), [])

    def test_local_tag_pushed_to_a_branch_counts(self) -> None:
        self.assertEqual(len(gate.pushed_branches([f"refs/tags/v1 {A} refs/heads/x {B}"])), 1)

    def test_blank_lines_are_ignored(self) -> None:
        self.assertEqual(gate.pushed_branches(["", "  "]), [])

    def test_malformed_line_cannot_be_measured(self) -> None:
        for line in ("refs/heads/x only three", "a b c d e"):
            with self.assertRaises(gate.CannotMeasure):
                gate.pushed_branches([line])

    def test_several_refs_keep_their_order(self) -> None:
        lines = [f"r1 {A} refs/heads/one {B}", f"r2 {B} refs/heads/two {ZERO}"]
        self.assertEqual([p.ref for p in gate.pushed_branches(lines)], ["refs/heads/one", "refs/heads/two"])


class ChangedPathsArgs(unittest.TestCase):
    def test_existing_ref_diffs_against_the_remote_sha(self) -> None:
        args = gate.changed_paths_args("origin", gate.Push("refs/heads/x", A, B))
        self.assertEqual(args[0], ["diff", "--no-renames", "--name-only", B, A])
        self.assertEqual(args[1][-1], f"{B}..{A}")

    def test_new_ref_excludes_what_the_remote_already_has(self) -> None:
        args = gate.changed_paths_args("origin", gate.Push("refs/heads/x", A, ZERO))
        self.assertEqual(len(args), 1)
        self.assertEqual(args[0][-3:], [A, "--not", "--remotes=origin"])

    def test_renames_are_not_followed_so_the_source_path_is_listed(self) -> None:
        for args in gate.changed_paths_args("origin", gate.Push("refs/heads/x", A, B)):
            self.assertIn("--no-renames", args)


class SteppedInTempRepo(unittest.TestCase):
    def test_rename_out_of_a_gate_input_lists_the_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args: str) -> str:
                return subprocess.run(["git", "-C", tmp, *args], capture_output=True, text=True, check=True).stdout.strip()

            git("init", "-q")
            git("config", "user.email", "t@example.invalid")
            git("config", "user.name", "t")
            (Path(tmp) / "tsconfig.json").write_text("{}", encoding="utf-8")
            git("add", ".")
            git("commit", "-q", "-m", "one")
            before = git("rev-parse", "HEAD")
            (Path(tmp) / ".claude").mkdir()
            git("mv", "tsconfig.json", ".claude/tsconfig.json")
            git("commit", "-q", "-m", "two")
            after = git("rev-parse", "HEAD")
            with mock.patch.object(gate, "REPO_ROOT", Path(tmp)):
                paths = gate.changed_paths("origin", gate.Push("refs/heads/x", after, before))
        self.assertIn("tsconfig.json", paths)


class GateInputs(unittest.TestCase):
    def test_status_line_paths_include_both_sides_of_a_rename(self) -> None:
        self.assertEqual(gate.status_paths("R  tsconfig.json -> .claude/tsconfig.json"),
                         ["tsconfig.json", ".claude/tsconfig.json"])
        self.assertEqual(gate.status_paths("?? notes.txt"), ["notes.txt"])

    def test_source_docs_and_workflows_are_inputs(self) -> None:
        for path in ("src/index.ts", "docs/WORKFLOW.md", "README.md", ".github/workflows/ci.yml", "package.json"):
            self.assertTrue(gate.is_gate_input(path), path)

    def test_files_no_step_reads_are_not_inputs(self) -> None:
        for path in (".qwenignore", "LICENSE"):
            self.assertFalse(gate.is_gate_input(path), path)

    def test_files_a_step_reads_are_inputs(self) -> None:
        # no-internal-references scans every *.md and .github; biome formats .claude/settings.json
        for path in ("SECURITY.md", "CONTRIBUTING.md", ".github/dependabot.yml", ".claude/settings.json"):
            self.assertTrue(gate.is_gate_input(path), path)

    def test_range_with_one_input_is_measured(self) -> None:
        self.assertTrue(gate.touches_gate_input(["LICENSE", "src/a.ts"]))
        self.assertFalse(gate.touches_gate_input(["LICENSE", ".qwenignore"]))
        self.assertFalse(gate.touches_gate_input([]))


if __name__ == "__main__":
    unittest.main()
