"""
Loads assistant.yaml: one commented place for the dashboard's settings.

Precedence (highest first): real environment variables, then .env, then
assistant.yaml, then the built-in defaults. So .env keeps working and keeps the
secrets; the YAML holds everything you might want to tune.

Uses PyYAML when it is installed; otherwise a small built-in parser that covers
what assistant.yaml uses (nested keys, scalars, simple lists, comments).
"""
import os
import pathlib

from jarvis import ROOT
CONFIG_PATH = pathlib.Path(os.path.expanduser(
    os.environ.get("ASSISTANT_CONFIG", str(ROOT / "config" / "assistant.yaml"))))

# yaml path -> environment variable read by the server modules
ENV_MAP = {
    "assistant.name": "ASSISTANT_NAME",
    "assistant.persona_file": "ASSISTANT_PERSONA",
    "server.port": "JARVIS_PORT",
    "server.open_browser": "JARVIS_OPEN",
    "hermes.mode": "JARVIS_HERMES_MODE",
    "hermes.command": "HERMES_CMD",
    "hermes.acp_command": "HERMES_ACP_CMD",
    "hermes.profile": "HERMES_PROFILE",
    "hermes.model": "JARVIS_MODEL",
    "hermes.toolsets": "HERMES_TOOLSETS",
    "hermes.workdir": "JARVIS_WORKDIR",
    "hermes.idle_timeout_s": "JARVIS_TIMEOUT",
    "hermes.tool_timeout_s": "JARVIS_TOOL_TIMEOUT",
    "hermes.permission_timeout_s": "JARVIS_PERMISSION_TIMEOUT",
    "voice.provider": "ASSISTANT_VOICE",
    "voice.whisper.mode": "WHISPER_MODE",
    "voice.whisper.url": "WHISPER_URL",
    "voice.whisper.model": "WHISPER_MODEL",
    "voice.whisper.language": "WHISPER_LANGUAGE",
    "voice.whisper.device": "WHISPER_DEVICE",
    "voice.whisper.compute_type": "WHISPER_COMPUTE_TYPE",
    "voice.whisper.beam_size": "WHISPER_BEAM_SIZE",
    "voice.kokoro.mode": "KOKORO_MODE",
    "voice.kokoro.url": "KOKORO_URL",
    "voice.kokoro.voice": "KOKORO_VOICE",
    "voice.kokoro.speed": "KOKORO_SPEED",
    "voice.kokoro.lang": "KOKORO_LANG",
    "voice.kokoro.model_path": "KOKORO_MODEL_PATH",
    "voice.kokoro.voices_path": "KOKORO_VOICES_PATH",
    "voice.elevenlabs.voice_id": "ELEVENLABS_VOICE_ID",
    "voice.elevenlabs.model": "ELEVENLABS_MODEL",
    "voice.elevenlabs.language": "ELEVENLABS_STT_LANGUAGE",
    "voice.elevenlabs.keyterms": "ELEVENLABS_STT_KEYTERMS",
    "voice.elevenlabs.stt_model": "ELEVENLABS_STT_MODEL",
    "logging.timings": "JARVIS_TIMING_LOG",
    "logging.log_dir": "JARVIS_LOG_DIR",
    "logging.raw_log": "JARVIS_RAW_LOG",
}

DATA = {}
STATUS = "not loaded"


def _scalar(v):
    v = v.strip()
    if not v:
        return None
    if (v[0] == v[-1]) and v[0] in "'\"" and len(v) >= 2:
        return v[1:-1]
    low = v.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("null", "~"):
        return None
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        return [_scalar(x) for x in inner.split(",")] if inner else []
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


def _strip_comment(line):
    quote = None
    for i, ch in enumerate(line):
        if ch in "'\"":
            quote = None if quote == ch else (quote or ch)
        elif ch == "#" and not quote and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _mini_yaml(text):
    """Nested mappings, scalars and '- item' lists. Enough for assistant.yaml."""
    root = {}
    stack = [(-1, root)]                     # (indent, container)
    pending = None                           # (indent, parent dict, key) awaiting a block
    for raw in text.splitlines():
        line = _strip_comment(raw).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        if pending and indent > pending[0]:
            _, parent, key = pending
            parent[key] = [] if body.startswith("- ") or body == "-" else {}
            stack.append((pending[0], parent[key]))
        elif pending:
            pending[1][pending[2]] = None
        pending = None
        container = stack[-1][1]
        if body.startswith("-"):
            if isinstance(container, list):
                container.append(_scalar(body[1:]))
            continue
        if ":" not in body or not isinstance(container, dict):
            continue
        key, _, val = body.partition(":")
        key = key.strip().strip("'\"")
        if val.strip():
            container[key] = _scalar(val)
        else:
            pending = (indent, container, key)
    if pending:
        pending[1][pending[2]] = None
    return root


def _get(path, default=None):
    node = DATA
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return default if node is None else node


def get(path, default=None):
    return _get(path, default)


def load():
    """Read assistant.yaml and set missing environment variables from it."""
    global DATA, STATUS
    if not CONFIG_PATH.exists():
        DATA, STATUS = {}, f"no {CONFIG_PATH.name} (using defaults)"
        return
    text = CONFIG_PATH.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
        DATA = yaml.safe_load(text) or {}
        STATUS = f"{CONFIG_PATH.name} (PyYAML)"
    except ImportError:
        DATA = _mini_yaml(text)
        STATUS = f"{CONFIG_PATH.name}"
    except Exception as e:  # noqa: BLE001 — a typo must not stop the server
        DATA, STATUS = {}, f"{CONFIG_PATH.name} could not be read ({e}); using defaults"
        return
    for path, env in ENV_MAP.items():
        val = _get(path)
        if val is None or val == "" or val == []:
            continue                         # blank = leave the built-in default
        if isinstance(val, bool):
            val = "1" if val else "0"
        elif isinstance(val, list):
            val = ",".join(str(x) for x in val)
        os.environ.setdefault(env, str(val))


def name():
    return (os.environ.get("ASSISTANT_NAME") or "Jarvis").strip() or "Jarvis"


def ui_settings():
    """Settings the browser applies: listening timings and speech options."""
    lis = _get("voice.listening", {}) or {}
    keys = {"silence_ms": "SILENCE_MS", "onset_ms": "ONSET_MS", "min_speech_ms": "MIN_SPEECH_MS",
            "max_turn_ms": "MAX_TURN_MS", "preroll_ms": "PREROLL_MS", "barge_in_ms": "BARGE_MS"}
    vad = {js: lis[y] for y, js in keys.items() if isinstance(lis.get(y), (int, float)) and lis[y] > 0}
    return {
        "name": name(),
        "vad": vad,
        "barge_in": _get("voice.barge_in", True) is not False,
        "earcon": _get("voice.earcon", True) is not False,
        "max_spoken_chars": _get("voice.max_spoken_chars", 700),
        "browser_language": _get("voice.browser_language", ""),
    }