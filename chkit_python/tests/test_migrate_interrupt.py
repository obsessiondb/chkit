"""Ctrl-C handling of migrate (#816), with real SIGINTs sent to this process."""

from __future__ import annotations

import os
import signal

import pytest

from chkit.cli.commands.migrate_interrupt import (
    InterruptLock,
    MigrateInterrupted,
    as_cleanup,
    deferred_interrupt,
    raise_if_interrupted,
    with_interrupt,
)


def _sigint() -> None:
    os.kill(os.getpid(), signal.SIGINT)


def test_a_sigint_in_a_deferred_block_waits_for_it_and_refuses_the_next_send(
    capsys: pytest.CaptureFixture[str],
) -> None:
    steps: list[str] = []

    def body() -> None:
        with deferred_interrupt():
            _sigint()
            steps.append("statement finished")
            with pytest.raises(MigrateInterrupted):
                raise_if_interrupted()
            steps.append("outcome recorded")
        steps.append("after the block")

    with pytest.raises(KeyboardInterrupt):
        with_interrupt(InterruptLock(claim="c1", released=True), body)

    assert steps == ["statement finished", "outcome recorded"]
    assert capsys.readouterr().err == (
        "migrate: interrupted (SIGINT). No new statement was started. "
        "The migrate lock is released.\n"
    )
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler


def test_an_error_in_a_deferred_block_is_reported_with_the_interrupt(
    capsys: pytest.CaptureFixture[str],
) -> None:
    def body() -> None:
        with deferred_interrupt():
            _sigint()
            raise RuntimeError("the completed record failed")

    with pytest.raises(KeyboardInterrupt) as raised:
        with_interrupt(InterruptLock(), body)

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert capsys.readouterr().err == (
        "migrate: interrupted (SIGINT). No new statement was started. "
        "This run held no migrate lock.\nthe completed record failed\n"
    )


def test_a_failed_cleanup_after_the_interrupt_is_reported(
    capsys: pytest.CaptureFixture[str],
) -> None:
    def body() -> None:
        try:
            _sigint()
        except KeyboardInterrupt as error:
            raise RuntimeError("not put back to prepared") from error

    with pytest.raises(KeyboardInterrupt):
        with_interrupt(InterruptLock(), body)

    assert capsys.readouterr().err.endswith("\nnot put back to prepared\n")


def test_a_nested_call_does_not_swallow_the_interrupt() -> None:
    def inner() -> None:
        _sigint()

    def body() -> None:
        with deferred_interrupt():
            with_interrupt(InterruptLock(), inner)

    with pytest.raises(KeyboardInterrupt):
        with_interrupt(InterruptLock(), body)


def test_after_a_sigint_only_cleanup_requests_are_let_through() -> None:
    steps: list[str] = []

    def body() -> None:
        with deferred_interrupt():
            _sigint()
            with pytest.raises(MigrateInterrupted):
                raise_if_interrupted()
            with as_cleanup():
                raise_if_interrupted()
                steps.append("outcome recorded")

    with pytest.raises(KeyboardInterrupt):
        with_interrupt(InterruptLock(), body)

    assert steps == ["outcome recorded"]


def test_a_base_exception_in_a_deferred_block_does_not_leave_deferral_on() -> None:
    def stop() -> None:
        with deferred_interrupt():
            raise SystemExit(2)

    with pytest.raises(SystemExit):
        with_interrupt(InterruptLock(), stop)

    def body() -> None:
        _sigint()

    with pytest.raises(KeyboardInterrupt):
        with_interrupt(InterruptLock(), body)


def test_without_a_sigint_nothing_changes() -> None:
    def body() -> str:
        with deferred_interrupt():
            raise_if_interrupted()
        return "done"

    assert with_interrupt(InterruptLock(), body) == "done"
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
