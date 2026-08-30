"""Single-brain bridge from OpenAI Realtime to Žán's /voice channel."""
import asyncio
import json
import logging
import urllib.error
import urllib.request
from typing import Any, Awaitable, Callable, Dict, TYPE_CHECKING

from pipecat.frames.frames import FunctionCallResultProperties

if TYPE_CHECKING:
    from pipecat.services.llm_service import FunctionCallParams

logger = logging.getLogger(__name__)


def get_ask_zan_tool_definition() -> Dict[str, Any]:
    return {
        "type": "function", "name": "ask_zan",
        "description": "Send the exact request to Žán, the only brain with memory, permissions and Home Assistant tools. Call exactly once for every turn.",
        "parameters": {"type": "object", "properties": {"text": {"type": "string", "description": "Exact user utterance."}}, "required": ["text"]},
    }


def _post_json(url: str, token: str, payload: dict, timeout: float) -> dict:
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def create_ask_zan_tool_handler(url: str, token: str, chat_id: int | None,
                                broadcast_json: Callable[[dict], Awaitable[None]],
                                timeout: float = 45.0, kanal: str | None = None):
    """Most na JEDEN mozek — i když se ptá víc satelitů.

    Args:
        broadcast_json: od 2026-08-30 sem patří ADRESNÝ odesílatel jednoho
            satelitu (`WebSocketHandler.json_sender`), ne broadcast — lokální
            potvrzení má zaznít tam, kde padl povel.
        kanal: odkud se ptáme (např. ``hlas:192.168.0.115``). Posílá se jako
            metadata; Žánův ``/voice`` čte jen ``text`` a ``chat_id``, takže je
            to zpětně kompatibilní. Chat zůstává SDÍLENÝ schválně: dva satelity
            nesmí být dva Žáni s oddělenou pamětí.
    """
    async def ask_zan(params: "FunctionCallParams") -> None:
        text = str((params.arguments or {}).get("text", "")).strip()
        if not text:
            await params.result_callback("Neslyšel jsem zadání.")
            return
        payload = {"text": text}
        if chat_id is not None:
            payload["chat_id"] = chat_id
        if kanal:
            payload["kanal"] = kanal
        try:
            result = await asyncio.to_thread(_post_json, url, token, payload, timeout)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            logger.error("Žán bridge failed: %r", exc)
            await params.result_callback("Teď se nedostanu ke svému mozku. Zkus to prosím znovu.")
            return
        reply = str(result.get("reply", "")).strip() or "Hotovo."
        if result.get("local_confirmation") == "success":
            await broadcast_json({"type": "local_confirmation", "value": "success", "text": reply})
            await params.result_callback({"status": "verified_success", "reply_played_locally": reply}, properties=FunctionCallResultProperties(run_llm=False))
            return
        await params.result_callback(reply)
    return ask_zan
