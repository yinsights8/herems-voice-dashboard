"""
Speech-to-text engines. The HUD's Voice menu picks one; there is no automatic
switching — a failure is reported with its reason and the user chooses.

  elevenlabs  ElevenLabs Scribe (voice.py), needs ELEVENLABS_API_KEY
  whisper     faster-whisper, local and free. Two ways to run it:
                http:  an OpenAI-compatible transcription server, e.g. Speaches:
                       docker run -d --name speaches -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
                       then download a model once:
                       curl -X POST http://localhost:8000/v1/models/Systran/faster-distil-whisper-small.en
                local: in this process: pip install faster-whisper (downloads the model on first use)

The browser's own speech recognition runs in the page and never reaches here.
"""
import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

from jarvis.voice import elevenlabs as voice

WHISPER_MODE = os.environ.get("WHISPER_MODE", "http").strip().lower()       # http | local
WHISPER_URL = os.environ.get("WHISPER_URL", "http://localhost:8000").rstrip("/")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "Systran/faster-distil-whisper-small.en").strip()
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en").strip()
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu").strip()
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip()
WHISPER_BEAM = int(os.environ.get("WHISPER_BEAM_SIZE", "1") or 1)

ENGINES = ("elevenlabs", "whisper")
_PROBE = {"at": 0.0, "ok": False, "detail": ""}
_local = {"model": None, "error": "", "lock": threading.Lock()}


class STTError(RuntimeError):
    pass


# ── availability ─────────────────────────────────────────────
def _whisper_status():
    if WHISPER_MODE == "local":
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False, "faster-whisper not installed (pip install faster-whisper)"
        if _local["error"]:
            return False, _local["error"]
        return True, f"local · {WHISPER_MODEL}"
    if time.monotonic() - _PROBE["at"] < 20:
        return _PROBE["ok"], _PROBE["detail"]
    ok, detail = False, f"no transcription server at {WHISPER_URL}"
    try:
        with urllib.request.urlopen(WHISPER_URL + "/v1/models", timeout=1.5) as r:
            ok = r.status < 500
            detail = f"server {WHISPER_URL} · {WHISPER_MODEL}"
            try:
                ids = [m.get("id") for m in json.loads(r.read()).get("data", [])]
                if ids and WHISPER_MODEL not in ids:
                    detail += " (model not downloaded yet?)"
            except ValueError:
                pass
    except urllib.error.HTTPError as e:
        ok, detail = e.code < 500, f"server {WHISPER_URL} · {WHISPER_MODEL}"
    except Exception:  # noqa: BLE001
        pass
    _PROBE.update(at=time.monotonic(), ok=ok, detail=detail)
    return ok, detail


def status():
    out = {"elevenlabs": {"ok": voice.available(),
                          "detail": "ElevenLabs Scribe" if voice.available() else "no ELEVENLABS_API_KEY in .env"}}
    ok, detail = _whisper_status()
    out["whisper"] = {"ok": ok, "detail": detail}
    return out


# ── engines ──────────────────────────────────────────────────
def _whisper_http(audio, mime):
    ext = {"audio/wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
           "audio/mpeg": "mp3"}.get(mime.split(";")[0], "wav")
    boundary = "----assistant" + uuid.uuid4().hex
    b = boundary.encode()

    def field(name, value):
        return b"--" + b + b"\r\n" + f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()

    body = b"".join([
        field("model", WHISPER_MODEL),
        field("response_format", "json"),
        field("language", WHISPER_LANGUAGE) if WHISPER_LANGUAGE else b"",
        b"--" + b + b"\r\n",
        f'Content-Disposition: form-data; name="file"; filename="turn.{ext}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(), audio, b"\r\n",
        b"--" + b + b"--\r\n",
    ])
    req = urllib.request.Request(WHISPER_URL + "/v1/audio/transcriptions", data=body, method="POST",
                                 headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return (json.loads(r.read()).get("text") or "").strip()


def _load_local():
    with _local["lock"]:
        if _local["model"] is None:
            from faster_whisper import WhisperModel
            _local["model"] = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
        return _local["model"]


def _whisper_local(audio, mime):
    import numpy as np
    model = _load_local()
    if mime.startswith("audio/wav"):
        # the HUD sends 16 kHz mono 16-bit WAV: hand Whisper the samples directly
        with wave.open(io.BytesIO(audio)) as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype("float32") / 32768.0
        src = pcm
    else:
        src = io.BytesIO(audio)
    segments, _info = model.transcribe(src, beam_size=WHISPER_BEAM,
                                       language=WHISPER_LANGUAGE or None, vad_filter=False)
    return "".join(s.text for s in segments).strip()


def _elevenlabs(audio, mime):
    return voice.transcribe(audio, mime)


_RUN = {"elevenlabs": _elevenlabs,
        "whisper": lambda a, m: (_whisper_local(a, m) if WHISPER_MODE == "local" else _whisper_http(a, m))}


def warm():
    """Load the in-process Whisper model in the background (local mode only)."""
    if WHISPER_MODE != "local":
        return

    def _w():
        try:
            _load_local()
        except Exception as e:  # noqa: BLE001
            _local["error"] = f"faster-whisper failed to load: {e}"[:200]
    threading.Thread(target=_w, daemon=True).start()


def _http_reason(e):
    try:
        body = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(body)
            body = j.get("detail") or j.get("error") or j.get("message") or body
            if isinstance(body, (dict, list)):
                body = json.dumps(body)
        except ValueError:
            pass
    except Exception:  # noqa: BLE001
        body = ""
    hint = {401: "API key rejected (expired or wrong)", 402: "no credits left", 403: "access refused",
            429: "rate limited or quota used up",
            404: f"model not found — download it: curl -X POST {WHISPER_URL}/v1/models/{WHISPER_MODEL}"}.get(e.code, "")
    return f"HTTP {e.code}" + (f" — {hint}" if hint else "") + (f": {str(body)[:200]}" if body else "")


def transcribe(audio, mime, engine):
    """Transcribe with exactly this engine. Returns (text, ms); raises STTError."""
    engine = (engine or "elevenlabs").lower()
    if engine not in ENGINES:
        raise STTError(f"{engine!r} is not a server engine")
    t = time.monotonic()
    try:
        text = _RUN[engine](audio, mime)
    except urllib.error.HTTPError as e:
        raise STTError(_http_reason(e)) from e
    except urllib.error.URLError as e:
        where = WHISPER_URL if engine == "whisper" else "api.elevenlabs.io"
        raise STTError(f"can't reach {where} ({e.reason})") from e
    except Exception as e:  # noqa: BLE001
        raise STTError(str(e)[:240] or type(e).__name__) from e
    return text, int((time.monotonic() - t) * 1000)