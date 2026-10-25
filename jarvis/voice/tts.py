"""
Text-to-speech engines with automatic fallback.

  elevenlabs  cloud, needs ELEVENLABS_API_KEY (voice.py)
  kokoro      local, free. Two ways to run it:
                http: the Kokoro-FastAPI server, e.g.
                      docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
                onnx: in-process via `pip install kokoro-onnx` plus the two model
                      files kokoro-v1.0.onnx and voices-v1.0.bin
  browser     the browser's own speechSynthesis; handled in the page, not here

synthesize(text, engine) tries the chosen engine and, when fallback is on, the
others. An ElevenLabs auth or quota error (expired key, no credits) parks
ElevenLabs for 10 minutes, so later turns go straight to Kokoro instead of
waiting on a failing call first.
"""
import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
import wave

from jarvis import ROOT
from jarvis.voice import elevenlabs as voice

KOKORO_MODE = os.environ.get("KOKORO_MODE", "http").strip().lower()          # http | onnx
KOKORO_URL = os.environ.get("KOKORO_URL", "http://localhost:8880").rstrip("/")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "bm_george").strip()
KOKORO_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0") or 1.0)
KOKORO_LANG = os.environ.get("KOKORO_LANG", "en-gb").strip()
KOKORO_MODEL_PATH = os.path.expanduser(os.environ.get("KOKORO_MODEL_PATH", "models/kokoro-v1.0.onnx"))
KOKORO_VOICES_PATH = os.path.expanduser(os.environ.get("KOKORO_VOICES_PATH", "models/voices-v1.0.bin"))
DEFAULT_ENGINE = os.environ.get("ASSISTANT_TTS", "auto").strip().lower()      # auto|elevenlabs|kokoro|browser
FALLBACK = os.environ.get("ASSISTANT_TTS_FALLBACK", "1") != "0"

ENGINES = ("elevenlabs", "kokoro")
_PARKED = {}                   # engine -> (until monotonic, reason)
_PROBE = {"at": 0.0, "ok": False, "detail": ""}
_onnx = {"model": None, "error": "", "lock": threading.Lock()}


def _resolve(path):
    if not os.path.isabs(path):
        path = str(ROOT / path)
    return path


# ── availability ─────────────────────────────────────────────
def _park(engine, reason, seconds=600):
    _PARKED[engine] = (time.monotonic() + seconds, reason)


def _parked(engine):
    until, reason = _PARKED.get(engine, (0, ""))
    return reason if time.monotonic() < until else ""


def _kokoro_status():
    if KOKORO_MODE == "onnx":
        try:
            import kokoro_onnx  # noqa: F401
        except ImportError:
            return False, "kokoro-onnx not installed (pip install kokoro-onnx)"
        for p in (KOKORO_MODEL_PATH, KOKORO_VOICES_PATH):
            if not os.path.isfile(_resolve(p)):
                return False, f"model file missing: {p}"
        if _onnx["error"]:
            return False, _onnx["error"]
        return True, "local (onnx)"
    # http: a cheap reachability probe, cached for 20 s
    if time.monotonic() - _PROBE["at"] < 20:
        return _PROBE["ok"], _PROBE["detail"]
    ok, detail = False, f"no Kokoro server at {KOKORO_URL}"
    try:
        with urllib.request.urlopen(KOKORO_URL + "/v1/audio/voices", timeout=1.5) as r:
            ok, detail = r.status < 500, f"server {KOKORO_URL}"
    except urllib.error.HTTPError as e:            # it answered, so it's up
        ok, detail = e.code < 500, f"server {KOKORO_URL}"
    except Exception:  # noqa: BLE001
        pass
    _PROBE.update(at=time.monotonic(), ok=ok, detail=detail)
    return ok, detail


def status():
    """{engine: {"ok": bool, "detail": str}} for the dropdown."""
    out = {}
    if not voice.available():
        out["elevenlabs"] = {"ok": False, "detail": "no ELEVENLABS_API_KEY in .env"}
    else:
        reason = _parked("elevenlabs")
        out["elevenlabs"] = {"ok": not reason, "detail": reason or f"voice {voice.voice_id()[:8]}…"}
    ok, detail = _kokoro_status()
    reason = _parked("kokoro")
    out["kokoro"] = {"ok": ok and not reason, "detail": reason or detail}
    return out


# ── engines ──────────────────────────────────────────────────
def _elevenlabs(text):
    try:
        return voice.speak(text), "audio/mpeg"
    except urllib.error.HTTPError as e:
        if e.code in (401, 402, 403, 429):
            _park("elevenlabs", f"ElevenLabs refused (HTTP {e.code}: key expired, no credits or rate limit)")
        raise


def _kokoro_http(text):
    req = urllib.request.Request(
        KOKORO_URL + "/v1/audio/speech",
        data=json.dumps({"model": "kokoro", "input": text[:2500], "voice": KOKORO_VOICE,
                         "response_format": "mp3", "speed": KOKORO_SPEED}).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), "audio/mpeg"


def _load_onnx():
    with _onnx["lock"]:
        if _onnx["model"] is None:
            from kokoro_onnx import Kokoro
            _onnx["model"] = Kokoro(_resolve(KOKORO_MODEL_PATH), _resolve(KOKORO_VOICES_PATH))
        return _onnx["model"]


def _kokoro_onnx(text):
    model = _load_onnx()
    try:
        samples, rate = model.create(text[:2500], voice=KOKORO_VOICE, speed=KOKORO_SPEED, lang=KOKORO_LANG)
    except TypeError:                                   # older releases: no lang argument
        samples, rate = model.create(text[:2500], voice=KOKORO_VOICE, speed=KOKORO_SPEED)
    try:
        import numpy as np                               # installed with kokoro-onnx
        pcm = (np.clip(np.asarray(samples, dtype="float32"), -1, 1) * 32767).astype("<i2").tobytes()
    except ImportError:
        pcm = b"".join(int(max(-1.0, min(1.0, float(s))) * 32767).to_bytes(2, "little", signed=True)
                       for s in samples)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm)
    return buf.getvalue(), "audio/wav"


def _kokoro(text):
    return _kokoro_onnx(text) if KOKORO_MODE == "onnx" else _kokoro_http(text)


_RUN = {"elevenlabs": _elevenlabs, "kokoro": _kokoro}


def warm():
    """Load the in-process Kokoro model in the background so the first reply isn't slow."""
    if KOKORO_MODE != "onnx" or DEFAULT_ENGINE == "browser":
        return

    def _w():
        if _kokoro_status()[0]:
            try:
                _load_onnx()
            except Exception as e:  # noqa: BLE001
                _onnx["error"] = f"kokoro-onnx failed to load: {e}"[:200]
    threading.Thread(target=_w, daemon=True).start()


def synthesize(text, engine=None):
    """Returns dict(audio, mime, engine, ms, fallback_from, reason). Raises when
    every engine tried failed (the page then uses browser speech)."""
    engine = (engine or DEFAULT_ENGINE or "auto").lower()
    if engine == "auto":
        order = list(ENGINES)
    elif engine in ENGINES:
        order = [engine] + ([e for e in ENGINES if e != engine] if FALLBACK else [])
    else:
        raise ValueError(f"engine {engine!r} is handled by the browser")
    st = status()
    errors = []
    for i, name in enumerate(order):
        if not st[name]["ok"] and (i > 0 or engine == "auto"):
            errors.append(f"{name}: {st[name]['detail']}")
            continue                                   # skip known-unavailable fallbacks
        t = time.monotonic()
        try:
            audio, mime = _RUN[name](text)
            return {"audio": audio, "mime": mime, "engine": name,
                    "ms": int((time.monotonic() - t) * 1000),
                    "fallback_from": order[0] if name != order[0] else None,
                    "reason": "; ".join(errors)}
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {str(e)[:120]}")
    raise RuntimeError("; ".join(errors) or "no TTS engine available")