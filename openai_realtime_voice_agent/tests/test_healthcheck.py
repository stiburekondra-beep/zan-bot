"""Offline test: healthcheck je zelený jen když hlas může fungovat.

Ověřuje `app.healthcheck.check()` proti heartbeat souboru ve všech stavech,
včetně přesného stavu incidentu 2026-08-23 (`disconnected` = zařízení
připojené, ale OpenAI socket mrtvý → MUSÍ být unhealthy).

Běží i bez pytestu: `python -m tests.test_healthcheck` projde všechny funkce
a skončí exit 1, když něco selže (v kontejneru pytest není — jako
test_connection_recovery.py)."""
import os
import tempfile
import time

from app import healthcheck


def _write(path, state, ts):
    with open(path, "w") as f:
        f.write(f"{state} {int(ts)}\n")


def test_connected_is_healthy():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        _write(p, "connected", time.time())
        assert healthcheck.check(p) == 0


def test_idle_is_healthy():
    # Krátké startovní okno, než vznikne služba — není to porucha.
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        _write(p, "idle", time.time())
        assert healthcheck.check(p) == 0


def test_disconnected_is_unhealthy():
    # Přesný stav incidentu: proces žije, socket na OpenAI mrtvý.
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        _write(p, "disconnected", time.time())
        assert healthcheck.check(p) == 1


def test_stale_connected_is_unhealthy():
    # Heartbeat stojí (smyčka/proces zamrzl) — i „connected" je zastaralý.
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        _write(p, "connected", time.time() - (healthcheck.MAX_AGE_S + 10))
        assert healthcheck.check(p) == 1


def test_fresh_boundary_connected_is_healthy():
    # Těsně uvnitř okna svěžesti zůstává zelený.
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        _write(p, "connected", time.time() - (healthcheck.MAX_AGE_S - 5))
        assert healthcheck.check(p) == 0


def test_corrupt_file_is_unhealthy():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "hb")
        with open(p, "w") as f:
            f.write("")  # prázdný / půlka řádku
        assert healthcheck.check(p) == 1


def test_missing_file_falls_back_to_port_check():
    # Chybějící soubor = startovní okno (kryto --start-period). check() spadne
    # na port-check; na volný náhodný port to dá unhealthy (nikdo neposlouchá).
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "chybi")
        os.environ["WEBSOCKET_PORT"] = "5"  # RFC-vyhrazený, nikdo neposlouchá
        try:
            assert healthcheck.check(p) == 1
        finally:
            del os.environ["WEBSOCKET_PORT"]


if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {e!r}")
    print(f"--- {len(fns) - failed}/{len(fns)} PASS ---")
    sys.exit(1 if failed else 0)
