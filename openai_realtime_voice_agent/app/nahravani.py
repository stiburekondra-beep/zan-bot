# -*- coding: utf-8 -*-
"""Nahrávací režim mostu: JEDEN klip z originálního mikrofonu satelitu.

PROČ TENHLE MODUL VŮBEC JE
──────────────────────────
Natáčení hlasových profilů a vzorků budicího slova se dělá ze skutečného
mikrofonu satelitu — u budicího slova na tom stojí recall, u otisku to, že
se hlas pozná i přes místnost. Jádro (`mozek/nataceni/zdroj-satelit.js`)
umí říct „natoč jeden vzorek" a počkat na zpětné volání; most to dosud
neměl čím obsloužit.

CO NA STÁVAJÍCÍM NAHRÁVÁNÍ NESEDĚLO
───────────────────────────────────
`AudioRecordingService` je diagnostika CELÉ RELACE: otevře soubor při
připojení satelitu a zavře ho při odpojení. Natáčení chce opak — jeden
soubor na jednu promluvu, na povel. A hlavně: jeho odbočka sedí v pipeline
až ZA `InputResampler`, takže by dodala 24 kHz dopočítané ze 16 kHz. Trenér
budicího slova chce originál.

Proto tenhle modul odbočuje o patro níž, přímo v `RawAudioSerializer`, kde
se z bajtů od satelitu teprve dělá pipecatí rámec: nativních 16 kHz mono
int16, dřív než na ně sáhne jakýkoli procesor.

DVĚ VĚCI, KTERÉ TU JSOU ZÁMĚRNĚ
───────────────────────────────
1. **Během nahrávání se model nevolá.** `prijmi()` vrací True = „tenhle
   zvuk je můj, do pipeline nejde". Nahrávací klip není dotaz; poslat ho do
   LLM by stálo peníze a Žán by na každou natáčenou větu odpověděl.
2. **Prázdný proud je CHYBA, ne prázdný soubor.** Na krabici leží šest set
   čtyřicetičtyřbajtových WAVů — samá hlavička, nula zvuku — a nikdo se to
   nedozvěděl, protože se nikdo neptal. Tady se ticho hlásí zpět jádru jako
   `chyba`, aby průvodce větu zopakoval místo čekání do vypršení.

Modul je schválně BEZ pipecatu a bez fastapi: dá se testovat na stroji,
kde ani jedno není (`tests/test_nataceni_klip.py`).
"""
import array
import asyncio
import json
import logging
import os
import re
import struct
import time
import urllib.request
from typing import Callable, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("zan.nahravani")

#: Mikrofon Voice PE jede 16 kHz mono int16 (`kMicSampleRate` ve firmwaru).
HZ_SATELIT = 16000
#: Kolik sekund se nahrává, když si jádro neřekne jinak.
DELKA_S = 6
MAX_DELKA_S = 30
#: Po tolika sekundách ticha PO ŘEČI se klip uzavře dřív než na strop.
TICHO_KONEC_S = 1.5
#: Špička int16, pod kterou to považujeme za ticho (linka Voice PE šumí pod ~120).
PRAH_TICHA = 220
#: Kratší klip než tohle nemá trenéru co dát — radši chyba než odpad.
MIN_ZVUKU_S = 0.25
#: Most a jádro běží na téže krabici; víc než pár sekund čekat nemá cenu.
TIMEOUT_ZPETNE_VOLANI_S = 8
#: Kolik sekund nad rámec `delka_s` se čeká, než hlídač usoudí „mikrofon mlčí".
REZERVA_HLIDACE_S = 2.0

#: `kam` je JMÉNO souboru, ne cesta. Žádné `..`, žádné podadresáře.
JMENO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.wav$")
KLIP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
#: Zpětné volání smí mířit jen na loopback — jádro běží na téže krabici.
POVOLENE_HOSTY = {"127.0.0.1", "localhost", "::1"}

VYCHOZI_TMP = "/homeassistant/zan_data/nataceni/tmp"


def vychozi_tmp_dir() -> str:
    """Kam se ukládají rozdělané klipy (`zan_data/nataceni/tmp`).

    Most má `/opt/ha/config` namountované jako `/homeassistant`, takže na
    `zan_data` dosáhne beze změny compose souboru.
    """
    return os.environ.get("ZAN_NATACENI_TMP", "").strip() or VYCHOZI_TMP


def token_jadra() -> str:
    """Token, kterým se most autentizuje ZPĚT k jádru."""
    return (os.environ.get("ZAN_AKCE_TOKEN", "").strip()
            or os.environ.get("ZAN_VOICE_TOKEN", "").strip())


def _spicka(audio: bytes) -> int:
    """Největší absolutní vzorek v int16 bloku (0 = digitální ticho)."""
    if not audio:
        return 0
    vzorky = array.array("h")
    vzorky.frombytes(audio[: len(audio) - (len(audio) % 2)])
    if not vzorky:
        return 0
    return max(max(vzorky), -min(vzorky))


def wav_hlavicka(hz: int, bajtu_dat: int) -> bytes:
    """44bajtová hlavička WAV PCM16 mono."""
    return (b"RIFF" + struct.pack("<I", 36 + bajtu_dat) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, hz, hz * 2, 2, 16)
            + b"data" + struct.pack("<I", bajtu_dat))


def _posli_zpet_http(url: str, telo: dict, token: str,
                     timeout: float = TIMEOUT_ZPETNE_VOLANI_S) -> Tuple[int, str]:
    """Zpětné volání jádru přes stdlib (stejně jako `zan_bridge_tool`)."""
    data = json.dumps(telo, ensure_ascii=False).encode("utf-8")
    hlavicky = {"content-type": "application/json"}
    if token:
        hlavicky["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=hlavicky, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as odpoved:
        return int(odpoved.status), odpoved.read(2000).decode("utf-8", "replace")


class NahravaciRezim:
    """Stavový automat jednoho klipu. Nejvýš jeden běží naráz.

    Rozhodování je celé tady (a otestované); `nahravani_server` je jen
    HTTP slupka, `raw_audio_serializer` jen trubka na zvuk.
    """

    def __init__(
        self,
        tmp_dir: Optional[str] = None,
        posli_zpet: Optional[Callable[..., Tuple[int, str]]] = None,
        probiha_rozhovor: Optional[Callable[[], bool]] = None,
        token: Optional[str] = None,
        hodiny: Callable[[], float] = time.monotonic,
        hlidac: bool = True,
        rezerva_s: float = REZERVA_HLIDACE_S,
    ):
        self._tmp_dir = tmp_dir or vychozi_tmp_dir()
        self._posli_zpet = posli_zpet or _posli_zpet_http
        self._probiha_rozhovor = probiha_rozhovor
        self._token = token
        self._hodiny = hodiny
        self._hlidac_zapnut = hlidac
        self._rezerva_s = float(rezerva_s)
        self._klip: Optional[dict] = None
        self._hlidac_task: Optional["asyncio.Task"] = None
        #: Poslední dokončený klip — jen pro diagnostiku a testy.
        self.posledni: Optional[dict] = None

    # ── stav ────────────────────────────────────────────────────────────

    @property
    def tmp_dir(self) -> str:
        """Kam klipy padají — do logu i do `GET /nahravani/stav`."""
        return self._tmp_dir

    def aktivni(self) -> bool:
        return self._klip is not None

    def stav(self) -> dict:
        if not self._klip:
            return {"nahravam": False}
        k = self._klip
        return {
            "nahravam": True,
            "klip_id": k["klip_id"],
            "typ": k["typ"],
            "bajtu": k["bajtu"],
            "delka_s": round(k["bajtu"] / 2.0 / max(1, k["hz"]), 3),
        }

    # ── start ───────────────────────────────────────────────────────────

    async def start(self, telo: dict) -> Tuple[int, dict]:
        """`POST /nahravani/start`. Vrací `(http_stav, odpoved)`.

        Jádro čeká `200 {"ok":true}` = „beru, ozvu se". Cokoli jiného je
        pro něj poctivé „ze satelitu to teď nejde" a natáčí se z telefonu.
        """
        if not isinstance(telo, dict):
            return 400, {"ok": False, "kod": "spatne_telo"}

        klip_id = str(telo.get("klip_id", "")).strip()
        if not KLIP_ID_RE.match(klip_id):
            return 400, {"ok": False, "kod": "spatny_klip_id"}

        typ = "wake" if str(telo.get("typ", "")).strip() == "wake" else "veta"

        try:
            delka_s = float(telo.get("delka_s") or DELKA_S)
        except (TypeError, ValueError):
            delka_s = DELKA_S
        delka_s = max(1.0, min(float(MAX_DELKA_S), delka_s))

        try:
            hz = int(telo.get("hz") or HZ_SATELIT)
        except (TypeError, ValueError):
            hz = HZ_SATELIT
        if hz < 8000 or hz > 48000:
            return 400, {"ok": False, "kod": "spatne_hz"}

        kam = str(telo.get("kam", "")).strip()
        if not JMENO_RE.match(kam):
            # `kam` je JMÉNO, ne cesta. Kdyby sem někdo poslal `../…`,
            # zapisovali bychom mimo složku natáčení.
            return 400, {"ok": False, "kod": "cesta_mimo"}

        zpetne_volani = str(telo.get("zpetne_volani", "")).strip()
        chyba_url = self._zkontroluj_url(zpetne_volani)
        if chyba_url:
            return 400, {"ok": False, "kod": chyba_url}

        if self._klip is not None:
            return 409, {"ok": False, "kod": "uz_nahravam",
                         "hlaska": "Jeden klip se právě natáčí."}

        if self._probiha_rozhovor is not None:
            try:
                probiha = bool(self._probiha_rozhovor())
            except Exception as exc:  # noqa: BLE001 - čidlo nesmí shodit most
                # FAIL-CLOSED: když nevím, jestli se mluví, nenahrávám.
                # Vlézt do běžícího hovoru je horší než natáčení odložit.
                logger.warning("⚠️ nevím, jestli běží rozhovor (%r) — nenahrávám", exc)
                return 409, {"ok": False, "kod": "nevim_o_hovoru",
                             "hlaska": "Nevím, jestli se zrovna mluví — nenahrávám."}
            if probiha:
                return 409, {"ok": False, "kod": "probiha_rozhovor",
                             "hlaska": "Zrovna běží rozhovor — vzorek si vezmu potom."}

        try:
            os.makedirs(self._tmp_dir, exist_ok=True)
            cesta = os.path.join(self._tmp_dir, kam)
            rozdelany = cesta + ".part"
            soubor = open(rozdelany, "wb")
            soubor.write(wav_hlavicka(hz, 0))
            soubor.flush()
        except OSError as exc:
            logger.error("🛑 nahrávání nejde otevřít (%s): %r", self._tmp_dir, exc)
            return 503, {"ok": False, "kod": "tmp_nejde",
                         "hlaska": "Nemám kam klip zapsat (%s)." % (exc.strerror or exc,)}

        self._klip = {
            "klip_id": klip_id,
            "typ": typ,
            "hz": hz,
            "kam": kam,
            "cesta": cesta,
            "rozdelany": rozdelany,
            "soubor": soubor,
            "zpetne_volani": zpetne_volani,
            "strop_bajtu": int(delka_s * hz) * 2,
            "bajtu": 0,
            "spicka": 0,
            "mluvilo": False,
            "ticho_bajtu": 0,
            "zacatek": self._hodiny(),
        }
        logger.info("🎙️ natáčím klip %s (%s, do %.1f s, %d Hz) -> %s",
                    klip_id[:8], typ, delka_s, hz, kam)

        if self._hlidac_zapnut:
            self._hlidac_task = asyncio.create_task(
                self._hlidej(delka_s + self._rezerva_s), name="nahravani-hlidac")
        return 200, {"ok": True, "klip_id": klip_id, "typ": typ, "delka_s": delka_s}

    def _zkontroluj_url(self, url: str) -> Optional[str]:
        """Zpětné volání smí jít jen na loopback — jinak by z mostu byla pumpa."""
        if not url:
            return "chybi_zpetne_volani"
        try:
            r = urlparse(url)
        except ValueError:
            return "spatne_zpetne_volani"
        if r.scheme not in ("http", "https") or not r.hostname:
            return "spatne_zpetne_volani"
        povolene = set(POVOLENE_HOSTY)
        navic = os.environ.get("ZAN_NATACENI_HOSTY", "").strip()
        if navic:
            povolene.update(h.strip().lower() for h in navic.split(",") if h.strip())
        if r.hostname.lower() not in povolene:
            return "zpetne_volani_mimo"
        return None

    # ── proud zvuku ─────────────────────────────────────────────────────

    async def prijmi(self, audio: bytes, hz: int) -> bool:
        """Zvuk od satelitu. True = „beru si ho", tedy do pipeline nejde.

        Volá se z `RawAudioSerializer.deserialize`, tedy PŘED resamplerem
        i před poloduplexní brzdou: nahrává se originál.
        """
        k = self._klip
        if k is None:
            return False
        if not audio:
            return True

        if hz != k["hz"]:
            # Nepřevzorkováváme schválně: celé natáčení stojí na tom, že
            # trenér dostane originál. Radši to říct nahlas.
            await self._dokonci(chyba="satelit posílá %d Hz, jádro chce %d Hz" % (hz, k["hz"]))
            return True

        if len(audio) % 2:
            # int16 se nesmí rozříznout — lichý ocásek by posunul celý zbytek.
            audio = audio[:-1]
            if not audio:
                return True

        try:
            k["soubor"].write(audio)
            k["bajtu"] += len(audio)
        except OSError as exc:
            await self._dokonci(chyba="zápis klipu selhal (%s)" % (exc.strerror or exc,))
            return True

        spicka = _spicka(audio)
        k["spicka"] = max(k["spicka"], spicka)
        if spicka >= PRAH_TICHA:
            k["mluvilo"] = True
            k["ticho_bajtu"] = 0
        elif k["mluvilo"]:
            k["ticho_bajtu"] += len(audio)

        if k["bajtu"] >= k["strop_bajtu"]:
            await self._dokonci()
            return True
        if k["mluvilo"] and k["ticho_bajtu"] >= int(TICHO_KONEC_S * k["hz"]) * 2:
            await self._dokonci()
            return True
        return True

    # ── konec ───────────────────────────────────────────────────────────

    async def stop(self, duvod: str = "na povel") -> Tuple[int, dict]:
        """`POST /nahravani/stop` — utnout, co se natočilo."""
        if self._klip is None:
            return 200, {"ok": True, "zastaveno": False}
        klip_id = self._klip["klip_id"]
        await self._dokonci(duvod=duvod)
        return 200, {"ok": True, "zastaveno": True, "klip_id": klip_id}

    async def _hlidej(self, po_sekundach: float) -> None:
        """Když satelit nepošle ani zvuk, ani ticho, klip nesmí viset navěky.

        Bez tohohle by uvázlý nahrávací režim spolkl mikrofon a dům by
        ohluchl — proto se režim vypíná i tehdy, když se nic neděje.
        """
        try:
            await asyncio.sleep(po_sekundach)
        except asyncio.CancelledError:
            return
        if self._klip is not None:
            await self._dokonci(duvod="čas vypršel")

    async def _dokonci(self, chyba: Optional[str] = None, duvod: str = "") -> None:
        k = self._klip
        if k is None:
            return
        self._klip = None

        # POZOR NA VLASTNÍ OCAS: když `_dokonci` běží Z hlídače, `cancel()`
        # by zrušil právě běžící task a zpětné volání by se na první
        # `await` rozsypalo — jádro by se o klipu nedozvědělo vůbec.
        hlidac = self._hlidac_task
        self._hlidac_task = None
        if hlidac is not None and hlidac is not asyncio.current_task():
            hlidac.cancel()

        try:
            k["soubor"].seek(0)
            k["soubor"].write(wav_hlavicka(k["hz"], k["bajtu"]))
            k["soubor"].flush()
        except OSError as exc:
            chyba = chyba or ("hlavičku WAV nejde dopsat (%s)" % (exc.strerror or exc,))
        finally:
            try:
                k["soubor"].close()
            except OSError:
                pass

        minimum = int(MIN_ZVUKU_S * k["hz"]) * 2
        if chyba is None:
            if k["bajtu"] <= 0:
                chyba = "ze satelitu nepřišel žádný zvuk"
            elif k["bajtu"] < minimum:
                chyba = "klip má jen %d ms zvuku" % (k["bajtu"] * 500 // k["hz"],)
            elif k["spicka"] < PRAH_TICHA:
                chyba = "mikrofon posílá ticho (špička %d)" % (k["spicka"],)

        if chyba is not None:
            # Vadný klip se NEUKLÁDÁ. Tichý 44bajtový soubor je horší než
            # chyba: tváří se jako nahrávka a nikdo se nedozví, že není.
            try:
                os.unlink(k["rozdelany"])
            except OSError:
                pass
            logger.warning("🎙️ klip %s NEnatočen: %s", k["klip_id"][:8], chyba)
            self.posledni = {"klip_id": k["klip_id"], "chyba": chyba}
            await self._ozvi_se(k, {"klip_id": k["klip_id"], "chyba": chyba})
            return

        try:
            # Atomicky: jádro nikdy nesmí přečíst půlku klipu.
            os.replace(k["rozdelany"], k["cesta"])
        except OSError as exc:
            zprava = "klip nejde přejmenovat (%s)" % (exc.strerror or exc,)
            logger.error("🛑 %s", zprava)
            self.posledni = {"klip_id": k["klip_id"], "chyba": zprava}
            await self._ozvi_se(k, {"klip_id": k["klip_id"], "chyba": zprava})
            return

        delka_ms = k["bajtu"] * 500 // k["hz"]
        logger.info("✅ klip %s natočen: %d B (%d ms, %d Hz)%s",
                    k["klip_id"][:8], k["bajtu"], delka_ms, k["hz"],
                    (" — " + duvod) if duvod else "")
        self.posledni = {"klip_id": k["klip_id"], "soubor": k["kam"],
                         "bajtu": k["bajtu"], "delka_ms": delka_ms}
        await self._ozvi_se(k, {"klip_id": k["klip_id"], "soubor": k["kam"]})

    async def _ozvi_se(self, k: dict, telo: dict) -> None:
        """Zpětné volání jádru. NEÚSPĚCH SE HLÁSÍ TAKY — ticho je horší zpráva.

        Chyba spojení tu končí: most nemá komu ji předat a nesmí kvůli ní
        spadnout. V logu ale zůstane, ať se dá dohledat.
        """
        url = k["zpetne_volani"]
        token = self._token if self._token is not None else token_jadra()
        try:
            loop = asyncio.get_running_loop()
            stav, telo_zpet = await loop.run_in_executor(
                None, self._posli_zpet, url, telo, token)
            if int(stav) >= 300:
                logger.warning("⚠️ jádro klip nepřevzalo (HTTP %s): %s",
                               stav, str(telo_zpet)[:200])
        except Exception as exc:  # noqa: BLE001 - zpětné volání nesmí shodit most
            logger.warning("⚠️ zpětné volání jádru selhalo: %r", exc)


# ── jeden režim na proces ───────────────────────────────────────────────
# Natáčí se vždycky jedna promluva jednoho člověka; víc naráz nedává smysl
# a `RawAudioSerializer` (jeden na satelit) se tak nemusí o nic starat.

_REZIM: Optional[NahravaciRezim] = None


def nastav_rezim(rezim: Optional[NahravaciRezim]) -> None:
    global _REZIM
    _REZIM = rezim


def aktivni_rezim() -> Optional[NahravaciRezim]:
    """Vrací režim, JEN když opravdu nahrává (jinak None).

    Serializér se ptá na každý paket, takže se tu nesmí nic počítat.
    """
    rezim = _REZIM
    if rezim is not None and rezim.aktivni():
        return rezim
    return None
