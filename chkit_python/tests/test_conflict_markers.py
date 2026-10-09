"""1:1 port of ``packages/core/src/conflict-markers.test.ts``."""

from __future__ import annotations

import pytest

from chkit.core import has_conflict_markers


@pytest.mark.parametrize(
    "text",
    [
        "a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n",
        "a\n<<<<<<< ours\nb\n||||||| base\nx\n=======\nc\n>>>>>>> theirs\n",
        "a\r\n<<<<<<<<< HEAD\r\nb\r\n=========\r\nc\r\n>>>>>>>>> feature\r\n",
        "<<<<<<<\n",
        "b\n=======  \nc\n",
    ],
)
def test_detects_the_lines_git_writes_for_a_conflict(text: str) -> None:
    assert has_conflict_markers(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "export const a = 1\n",
        "  <<<<<<< HEAD\n",
        "<<<<<< six\n",
        "======= heading\n",
        "const sql = 'a <<<<<<< b'\n",
        "<<<<<<<HEAD\n",
    ],
)
def test_ignores_marker_like_text_that_git_does_not_write(text: str) -> None:
    assert has_conflict_markers(text) is False
