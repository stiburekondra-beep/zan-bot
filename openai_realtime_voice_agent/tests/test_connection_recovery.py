"""Offline test: ConnectionRecovery must keep retrying when the OpenAI
websocket never came up (silent failure after `Error connecting`)."""
import asyncio
import time

import pytest

from app.websocket_handler import ConnectionRecovery


class FakeService:
    """Mimics pipecat's service: `_websocket` is None until connect succeeds."""

    def __init__(self, succeed_on_attempt: int):
        self._websocket = None
        self.attempts = 0
        self._succeed_on = succeed_on_attempt

    async def reset_conversation(self):
        self.attempts += 1
        if self.attempts >= self._succeed_on:
            self._websocket = object()  # live socket
        # pipecat swallows connect errors: no raise, _websocket stays None


class FakePhaseEmitter:
    def __init__(self):
        self.idles = []

    async def force_idle(self, reason):
        self.idles.append(reason)


@pytest.mark.asyncio
async def test_watchdog_reconnects_after_silent_connect_failure():
    svc = FakeService(succeed_on_attempt=3)
    pe = FakePhaseEmitter()
    rec = ConnectionRecovery(openai_service=svc, phase_emitter=pe)
    # speed up for the test
    rec.WATCH_CHECK_S = 0.02
    rec.WATCH_BACKOFF_MIN_S = 0.05
    rec.WATCH_BACKOFF_MAX_S = 0.2
    rec.RECONNECT_COOLDOWN_S = 0.01
    rec._watch_backoff = rec.WATCH_BACKOFF_MIN_S

    task = asyncio.create_task(rec._connection_watch_loop())
    t0 = time.monotonic()
    while svc._websocket is None and time.monotonic() - t0 < 5:
        await asyncio.sleep(0.02)
    task.cancel()

    assert svc._websocket is not None, "watchdog never got the socket up"
    assert svc.attempts == 3, f"expected 3 attempts, got {svc.attempts}"
    assert pe.idles, "device must be unstuck (idle) during recovery"
    # backoff resets to minimum after a success
    assert rec._watch_backoff == rec.WATCH_BACKOFF_MIN_S


@pytest.mark.asyncio
async def test_watchdog_is_quiet_when_connected():
    svc = FakeService(succeed_on_attempt=1)
    svc._websocket = object()
    rec = ConnectionRecovery(openai_service=svc, phase_emitter=FakePhaseEmitter())
    rec.WATCH_CHECK_S = 0.01
    task = asyncio.create_task(rec._connection_watch_loop())
    await asyncio.sleep(0.1)
    task.cancel()
    assert svc.attempts == 0


def test_error_connecting_is_a_reconnect_trigger():
    assert any(m in "Error connecting: timed out during opening handshake"
               for m in ConnectionRecovery._CONNECT_FAILED_MARKERS)
