"""
JARVIS Live — a HUD that drives Hermes Agent.

    python3 server.py

The brain is your own Hermes Agent CLI/profile. Hermes keeps access to the same
configured tools, browser/Chrome automation, MCP servers, skills, memory, and
third-party integrations that your normal Hermes sessions have. Voice can use the
browser Web Speech API, with optional server-side ElevenLabs STT/TTS if present.
"""
import hashlib
import json
import mimetypes
import os
import pathlib
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# Windows terminals (Git Bash, cmd) default to cp1252 and crash on the banner's
# box-drawing characters. Force UTF-8 for everything this process prints.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = pathlib.Path(__file__).resolve().parent
UI = ROOT / "ui"

# load .env before importing anything that reads os.environ
_env = ROOT / ".env"
if _env.exists():
    for line in _env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import commands         # noqa: E402
import runtime          # noqa: E402
import voice            # noqa: E402

PORT = int(os.environ.get("JARVIS_PORT", "8730"))
API_TOKEN = secrets.token_urlsafe(32)
RUN_LOCK = threading.Lock()
MAX_JSON_BODY = 1024 * 1024
MAX_AUDIO_BODY = 12 * 1024 * 1024

# Latency logging. Each turn's timings (no prompts, transcripts or answers)
# are appended to logs/timings.jsonl and summarised on this terminal.
# JARVIS_TIMING_LOG=0 turns both off.
TIMING_ON = os.environ.get("JARVIS_TIMING_LOG", "1") != "0"
LOG_DIR = pathlib.Path(os.path.expanduser(os.environ.get("JARVIS_LOG_DIR", str(ROOT / "logs"))))
_TIMING_LOCK = threading.Lock()


def _ms(t):
    return int((time.monotonic() - t) * 1000)


def _print_timing(tag, d):
    if TIMING_ON:
        parts = " ".join(f"{k.replace('_ms', '')}={v}" for k, v in d.items()
                         if isinstance(v, (int, float, str)))
        sys.stderr.write(f"  [timing] {tag} {parts}\n")
        sys.stderr.flush()


def _read_timings(limit):
    """The newest `limit` records from timings.jsonl, oldest first. Reads only the
    end of the file, so it stays fast as the log grows."""
    path = LOG_DIR / "timings.jsonl"
    if not path.exists():
        return []
    with _TIMING_LOCK, open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        chunk = min(size, max(64 * 1024, limit * 4096))
        f.seek(size - chunk)
        lines = f.read().decode("utf-8", "replace").splitlines()
    if chunk < size:
        lines = lines[1:]                     # first line may be cut mid-record
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _append_timing(record):
    if not TIMING_ON:
        return
    record["logged_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    line = json.dumps(record, separators=(",", ":")) + "\n"
    with _TIMING_LOCK:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / "timings.jsonl", "a", encoding="utf-8") as f:
            f.write(line)

# The Jarvis persona, appended to every run. Without it, the model answers as a
# coding agent and narrates its own tooling — which is not what you want spoken
# out loud. Edit persona.md to change how it talks.
_PERSONA_FILE = ROOT / "persona.md"


def persona():
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    extra = commands.context_block()      # profile / goal / personality / queue
    return "\n\n".join(x for x in (base, extra) if x)
# One continuing Hermes conversation until the user hits /new.
SESSION = {"id": None, "persona_hash": None}


def _persona_for_turn(extra):
    """The persona is sent on the first turn of a session, and again only when it
    changes (/goal, /personality, /mission edits). Resent every turn, each copy
    stays in the resumed session's history and the prompt grows turn by turn."""
    full = "\n\n".join(x for x in (persona(), extra) if x)
    digest = hashlib.sha1(full.encode("utf-8")).hexdigest()
    if SESSION["id"] and SESSION.get("persona_hash") == digest:
        return None, digest
    return (full or None), digest


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    # ── helpers ──────────────────────────────────────────────
    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data, ctype, code=200, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _read(self, limit):
        n = int(self.headers.get("Content-Length", 0))
        if n < 0 or n > limit:
            raise ValueError(f"request body exceeds {limit} bytes")
        return self.rfile.read(n) if n else b""

    def _host_ok(self):
        host = self.headers.get("Host", "")
        return host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin in {
            f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"
        }

    def _token_ok(self):
        supplied = self.headers.get("X-Jarvis-Token", "")
        return bool(supplied) and secrets.compare_digest(supplied, API_TOKEN)

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "invalid host"}, 403)
        p = urlparse(self.path).path
        if p == "/api/status":
            return self._json(dict(
                runtime=runtime.runtime_kind(),
                permission=runtime.PERMISSION,
                profile=runtime.PROFILE,
                source=runtime.SOURCE,
                workdir=runtime.WORKDIR,
                model=runtime.MODEL or "Hermes default",
                tools=runtime.hermes_tools_snapshot(),
                browser_stt=True,
                browser_tts=True,
                voice_mode=os.environ.get("JARVIS_VOICE_MODE", "elevenlabs" if voice.available() else "browser"),
                voice_id=voice.voice_id() if voice.available() else "browser",
                stt="elevenlabs" if voice.available() else "browser",
                tts="elevenlabs" if voice.available() else "browser",
                hermes_mode=runtime.mode_label() if runtime.runtime_kind() == "hermes" else None,
                session=SESSION["id"]))
        if p == "/api/timings":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            try:
                limit = max(1, min(1000, int((q.get("limit") or ["200"])[0])))
            except ValueError:
                limit = 200
            return self._json({"records": _read_timings(limit), "logging": TIMING_ON,
                               "mode": runtime.mode_label() if runtime.runtime_kind() == "hermes" else None})
        if p == "/api/jobs":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            # finished background missions, reported once each
            return self._json(dict(done=commands.take_finished(),
                                   running=[j for j in commands.jobs_snapshot()
                                            if j["status"] == "running"]))

        rel = "index.html" if p == "/" else p.lstrip("/")
        f = (UI / rel).resolve()
        if not str(f).startswith(str(UI.resolve())) or not f.is_file():
            return self._bytes(b"not found", "text/plain", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        data = f.read_bytes()
        if f.suffix == ".html":
            data = data.replace(b"__JARVIS_TOKEN__", API_TOKEN.encode())
        return self._bytes(data, ctype)

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self):
        p = urlparse(self.path).path
        if not self._host_ok() or not self._origin_ok():
            return self._json({"error": "request origin rejected"}, 403)
        if not self._token_ok():
            return self._json({"error": "unauthorized"}, 401)
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if p in {"/api/run", "/api/speak", "/api/new", "/api/cancel", "/api/timing", "/api/permission"} and ctype != "application/json":
            return self._json({"error": "application/json required"}, 415)
        if p == "/api/listen" and not ctype.startswith("audio/"):
            return self._json({"error": "audio content type required"}, 415)
        try:
            raw = self._read(MAX_AUDIO_BODY if p == "/api/listen" else MAX_JSON_BODY)
        except (TypeError, ValueError):
            return self._json({"error": "request body too large"}, 413)

        if p == "/api/speak":
            try:
                text = (json.loads(raw or b"{}").get("text") or "").strip()
                t = time.monotonic()
                audio = voice.speak(text)
                tts_ms = _ms(t)
                _print_timing("tts", {"elevenlabs_tts_ms": tts_ms, "chars": len(text)})
                return self._bytes(audio, "audio/mpeg", headers={"X-Jarvis-Tts-Ms": str(tts_ms)})
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 503)

        if p == "/api/listen":
            try:
                mime = self.headers.get("Content-Type", "audio/webm")
                t = time.monotonic()
                text = voice.transcribe(raw, mime)
                stt = {"elevenlabs_stt_ms": _ms(t), "bytes": len(raw)}
                _print_timing("stt", stt)
                return self._json({"text": text, "timing": stt})
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:300], "text": ""}, 503)

        if p == "/api/new":
            runtime.cancel_active()
            runtime.refresh_caches()
            SESSION["id"] = None
            return self._json({"ok": True})

        if p == "/api/cancel":
            # Stop the running Hermes process but keep the conversation thread:
            # SESSION only ever holds the last *completed* session, so resuming
            # it after a cancel is safe. Use /new to start a fresh thread.
            stopped = runtime.cancel_active()
            return self._json({"ok": True, "stopped": stopped})

        if p == "/api/permission":
            # the user's answer to a Hermes tool-approval request
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._json({"error": "bad json"}, 400)
            option = body.get("option_id")
            ok = runtime.answer_permission(str(body.get("id") or ""),
                                           str(option) if option else None)
            return self._json({"ok": ok}, 200 if ok else 409)

        if p == "/api/timing":
            # the browser's complete record of one turn (stage durations only)
            try:
                rec = json.loads(raw or b"{}")
                if not isinstance(rec, dict):
                    raise ValueError("record must be an object")
                _append_timing(rec)
            except (ValueError, OSError) as e:
                return self._json({"error": str(e)[:200]}, 400)
            return self._json({"ok": True})

        if p == "/api/run":
            if not RUN_LOCK.acquire(blocking=False):
                return self._json({"error": "JARVIS is already processing a request"}, 409)
            try:
                return self._stream_run(raw)
            finally:
                RUN_LOCK.release()

        return self._json({"error": "no such endpoint"}, 404)

    # ── the run: NDJSON stream of events ─────────────────────
    def _stream_run(self, raw):
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        t_run = time.monotonic()
        srv = {}
        turn_id = str(payload.get("turn_id") or "")[:32]
        message = (payload.get("message") or "").strip()
        extra = (payload.get("system") or "").strip()
        t = time.monotonic()
        system = "\n\n".join(x for x in (persona(), extra) if x) or None
        srv["persona_ms"] = _ms(t)
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        if fresh:
            SESSION["id"] = None
            runtime.refresh_caches()       # /new also picks up newly connected tools

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev) + "\n").encode())
            self.wfile.flush()

        # ── the command matrix: /new /profile /goal /personality /kanban /mission /background /tools /status /browser
        t = time.monotonic()
        cmd = commands.handle(
            message,
            runner=lambda m: runtime.run(m, None, persona()))
        srv["command_ms"] = _ms(t)
        if cmd:
            if cmd.get("note"):
                emit(dict(t="note", message=cmd["note"]))
            if cmd.get("fresh"):
                SESSION["id"] = None
            if cmd.get("message") is None:
                # answered locally — no model call needed
                emit(dict(t="delta", text=cmd.get("reply", "Done.")))
                srv["server_total_ms"] = _ms(t_run)
                _print_timing(f"run {turn_id} (local command)", srv)
                emit(dict(t="complete", ms=0, timing=srv))
                return
            message = cmd["message"]
            system = "\n\n".join(x for x in (persona(), extra) if x) or None

        if SESSION["id"] and not runtime.session_usable(SESSION["id"]):
            SESSION["id"] = None           # e.g. hermes-acp restarted: start fresh, resend persona
        t = time.monotonic()
        system, phash = _persona_for_turn(extra)
        srv["persona_ms"] = srv.get("persona_ms", 0) + _ms(t)
        srv["persona_sent"] = 1 if system else 0
        srv["prompt_chars"] = len(message) + len(system or "")
        rt = {}
        try:
            full = "\n\n".join(x for x in (persona(), extra) if x) or None
            for ev in runtime.run(message, SESSION["id"], system, timing=rt, full_system=full):
                if ev.get("t") in ("complete", "error"):
                    ev = dict(ev, timing={**srv, **rt, "server_total_ms": _ms(t_run)})
                    _print_timing(f"run {turn_id}", ev["timing"])
                # Only remember a real Hermes session, never demo/mock identifiers.
                sid = ev.get("session_id")
                # Only remember a session that actually COMPLETED. Storing it from
                # `status` (which fires at init) means one broken run poisons every
                # run after it with --resume <half-born session>.
                if ev.get("t") == "complete" and runtime.valid_session(sid):
                    SESSION["id"] = sid
                    SESSION["persona_hash"] = phash
                if ev.get("t") == "error":
                    SESSION["id"] = None       # drop a bad/stale session so the next run is fresh
                emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass                                          # client navigated away
        except Exception as e:                            # noqa: BLE001
            try:
                emit(dict(t="error", message=str(e)[:300]))
            except OSError:
                pass


def main():
    kind = runtime.runtime_kind()
    brain = ("Hermes Agent (profile tools, skills, memory, MCP, browser integrations live)"
             if kind == "hermes" else "MOCK — Hermes CLI not reachable")
    vo = (f"ElevenLabs · {voice.voice_id()[:8]}…" if voice.available()
          else "none (add ELEVENLABS_API_KEY for voice)")
    perm = runtime.PERMISSION
    perm_note = ("  can run tools without asking — set JARVIS_PERMISSION=default to require approval"
                 if perm == "bypass" else "")

    print(f"""
  JARVIS · Hermes Live HUD
  ──────────────────────────────────────────────
  brain        {brain}
  profile      {runtime.PROFILE}
  workdir      {runtime.WORKDIR}
  hermes       {runtime.mode_label() if kind == "hermes" else "-"}
  permission   {perm}{perm_note}
  voice        {vo} + browser Web Speech fallback
  open         http://localhost:{PORT}
""", flush=True)

    if kind == "hermes":
        runtime.warm_caches()            # fill the tool list in the background
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    if os.environ.get("JARVIS_OPEN", "1") != "0":
        webbrowser.open(f"http://localhost:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  down.")
        srv.shutdown()


if __name__ == "__main__":
    main()