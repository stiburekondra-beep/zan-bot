"""Registr satelitů na mostě — kdo je připojený a kolik jich smí být.

Proč vůbec existuje
-------------------
Pipecatí ``WebsocketServerTransport`` je stavěný na JEDNO spojení: jeho
vstupní transport si v ``_client_handler`` drží ``self._websocket`` a když
přijde druhý klient, ten první ZAVŘE (``server.py:191``); výstupní transport
dělá totéž v ``set_client_connection`` (``server.py:284`` — hláška
``Only one client allowed, using new connection``). Dva satelity se pak
navzájem odkopávají donekonečna (26. 8. naměřeno 74 přepnutí za 90 s).

Řešení je vpředu, ne uvnitř pipecatu: port drží naše vstupní brána
(``WebSocketHandler.serve_forever``) a KAŽDÉ přijaté spojení dostane vlastní
transport + vlastní pipeline + vlastní OpenAI Realtime relaci. Tenhle registr
je mapa ``client_id → ClientSlot``, která k tomu drží účetnictví:

* **strop** (``ZAN_MAX_KLIENTU``, výchozí 2) — třetí satelit se ODMÍTNE
  a stávající dva běží dál. Nikdy se neodkopává ten, kdo už mluví.
* **reconnect téhož zařízení** — když se stejné ``client_id`` připojí znovu
  (wifi blikla, firmware se restartoval), nahradí SVŮJ starý slot; strop tím
  neprojídá a druhého satelitu se to netýká.

Modul je schválně čistý Python (žádný pipecat, žádné IO), aby šel testovat
na notebooku, kde most nikdy nepoběží — viz ``tests/test_multiklient.py``.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: Kolik satelitů most unese, když to nikdo neřekne jinak (Voice PE + reSpeaker).
DEFAULT_MAX_CLIENTS = 2

#: Verdikty rezervace.
ACCEPTED = "accepted"          # nový klient, je pro něj místo
REPLACED = "replaced"          # totéž zařízení se připojilo znovu
REJECTED_FULL = "rejected_full"    # strop je vyčerpaný
REJECTED_BUDGET = "rejected_budget"  # denní rozpočet je vyčerpaný (tvrdý režim)


@dataclass
class ClientSlot:
    """Jeden satelit a všechno, co k němu na mostě patří.

    Každá položka je JEHO — transport, pipeline, OpenAI relace i fázový
    kanál. Nic z toho se s druhým satelitem nesdílí, takže povel řečený sem
    se nemůže projevit tam (a naopak).
    """

    client_id: str
    websocket: Any = None
    transport: Any = None
    serializer: Any = None
    service: Any = None
    pipeline: Any = None
    runner: Any = None
    task: Any = None
    runner_task: Any = None
    phase_emitter: Any = None
    turn_liveness: Any = None
    connected_at: float = field(default_factory=time.time)
    # Nastaví se, jakmile je slot uklizený — brání dvojímu teardownu.
    torn_down: bool = False

    @property
    def age_s(self) -> float:
        """Jak dlouho je satelit připojený (sekundy)."""
        return max(0.0, time.time() - self.connected_at)

    def __repr__(self) -> str:  # pragma: no cover - jen do logu
        return f"<ClientSlot {self.client_id} age={self.age_s:.0f}s>"


class ClientRegistry:
    """Mapa připojených satelitů se stropem.

    ``reserve()`` je ZÁMĚRNĚ synchronní: běží celá v jednom kroku smyčky
    událostí, takže dva souběžné connecty se nemůžou protnout uprostřed
    a oba projít stropem. Všechno pomalé (stavba pipeline, OpenAI relace)
    se dělá až PO rezervaci.
    """

    def __init__(self, max_clients: int = DEFAULT_MAX_CLIENTS):
        self.max_clients = max(1, int(max_clients))
        self._slots: Dict[str, ClientSlot] = {}

    # ---- čtení -----------------------------------------------------------

    def __len__(self) -> int:
        return len(self._slots)

    @property
    def count(self) -> int:
        """Kolik satelitů je právě teď na mostě."""
        return len(self._slots)

    def get(self, client_id: str) -> Optional[ClientSlot]:
        """Slot daného satelitu, nebo ``None``."""
        return self._slots.get(client_id)

    def all(self) -> List[ClientSlot]:
        """Všechny sloty (kopie seznamu — bezpečné pro iteraci při úklidu)."""
        return list(self._slots.values())

    def ids(self) -> List[str]:
        """Jména připojených satelitů (pro log)."""
        return list(self._slots.keys())

    def is_full(self) -> bool:
        """Je most na stropu?"""
        return len(self._slots) >= self.max_clients

    # ---- zápis -----------------------------------------------------------

    def reserve(self, client_id: str) -> Tuple[str, Optional[ClientSlot], Optional[ClientSlot]]:
        """Zamluvit místo pro satelit.

        Returns:
            ``(verdikt, novy_slot, stary_slot)``. U ``REJECTED_FULL`` je nový
            slot ``None`` a **s nikým se nehýbe** — stávající satelity běží dál.
            U ``REPLACED`` je ve třetí položce starý slot TÉHOŽ zařízení,
            který má volající uklidit.
        """
        existing = self._slots.get(client_id)
        if existing is not None:
            fresh = ClientSlot(client_id=client_id)
            self._slots[client_id] = fresh
            logger.info(
                "♻️ satelit %s se připojil znovu — přebírá svůj vlastní slot "
                "(na mostě %d/%d)", client_id, len(self._slots), self.max_clients,
            )
            return REPLACED, fresh, existing

        if self.is_full():
            logger.warning(
                "🚧 most je plný (%d/%d: %s) — odmítám %s; připojené satelity "
                "běží dál a NIKDO se neodkopává",
                len(self._slots), self.max_clients, ", ".join(self.ids()), client_id,
            )
            return REJECTED_FULL, None, None

        fresh = ClientSlot(client_id=client_id)
        self._slots[client_id] = fresh
        logger.info(
            "✅ satelit %s přijat (na mostě %d/%d)",
            client_id, len(self._slots), self.max_clients,
        )
        return ACCEPTED, fresh, None

    def release(self, slot: ClientSlot) -> bool:
        """Uvolnit slot — jen když je to pořád TENHLE slot.

        Pozdní úklid odpojeného satelitu tak nesmaže jeho vlastní čerstvé
        spojení (reconnect), ani slot někoho jiného.

        Returns:
            ``True``, když se slot opravdu odebral.
        """
        current = self._slots.get(slot.client_id)
        if current is not slot:
            logger.debug(
                "slot %s už patří jinému spojení — neuvolňuju", slot.client_id
            )
            return False
        del self._slots[slot.client_id]
        logger.info(
            "🔌 satelit %s odpojen (na mostě %d/%d)",
            slot.client_id, len(self._slots), self.max_clients,
        )
        return True
