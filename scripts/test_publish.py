#!/usr/bin/env python3
"""Regression tests for merging long-running research state with archive base state."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("GITHUB_REPO", "example/test")
os.environ.setdefault("GITHUB_PAT", "dummy")
os.environ.setdefault("GITHUB_BASE", "main")

_spec = importlib.util.spec_from_file_location(
    "publish_under_test", Path(__file__).with_name("publish.py")
)
publish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(publish)

BOARD_HEADER = """# 研究看板

| # | 主题 | 优先级 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
"""


class PublishStateMergeTests(unittest.TestCase):
    def test_board_merges_base_only_rows_and_keeps_local_updates(self):
        base = BOARD_HEADER + "| 7 | base | 高 | 待研究 | old |\n| 8 | base-new | 高 | 待研究 | keep |\n"
        local = BOARD_HEADER + "| 7 | local | 高 | 已产出 | local wins |\n"
        merged = publish._merge_board(base, local)
        self.assertIn("| 7 | local |", merged)
        self.assertIn("| 8 | base-new |", merged)
        self.assertNotIn("| 7 | base |", merged)

    def test_copy_outputs_readds_base_state_after_runtime_copy(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            runtime = root / "runtime" / "outputs"
            work_outputs = root / "work" / "data" / "outputs"
            runtime.mkdir(parents=True)
            work_outputs.mkdir(parents=True)
            (runtime / "研究看板.md").write_text(
                BOARD_HEADER + "| 7 | local | 高 | 已产出 | local wins |\n",
                encoding="utf-8",
            )
            (runtime / "研究经验.md").write_text("", encoding="utf-8")
            (work_outputs / "研究看板.md").write_text(
                BOARD_HEADER + "| 7 | base | 高 | 待研究 | old |\n| 8 | base-new | 高 | 待研究 | keep |\n",
                encoding="utf-8",
            )
            (work_outputs / "研究经验.md").write_text(
                "# 研究经验\n\n- base-only note\n", encoding="utf-8"
            )
            publish.DATA = root / "runtime"
            self.assertTrue(publish._copy_outputs(str(root / "work")))
            board = (work_outputs / "研究看板.md").read_text(encoding="utf-8")
            experience = (work_outputs / "研究经验.md").read_text(encoding="utf-8")
            self.assertIn("| 7 | local |", board)
            self.assertIn("| 8 | base-new |", board)
            self.assertEqual(experience, "# 研究经验\n\n- base-only note\n")
            self.assertEqual(list((work_outputs.parent).glob(".*.base")), [])


if __name__ == "__main__":
    unittest.main()
