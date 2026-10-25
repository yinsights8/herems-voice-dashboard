"""
Persistent Hermes runtime over ACP (Agent Client Protocol).

`hermes chat` pays 10-14 s of start-up on every turn (plugins, providers,
credentials, session set-up). `hermes-acp` is the same agent as a long-running
JSON-RPC server on stdin/stdout: start it once, keep sessions open, and each
turn costs only the model call (about 1-2 s for a short answer). It also streams
the answer and reports tool calls as they happen.

Used by runtime.run() when JARVIS_HERMES_MODE is "auto" (the default, when
hermes-acp can be found) or "acp". Any start-up failure falls back to the
per-turn `hermes chat` path.

Safety: Hermes asks before running tools that need approval. Those requests are
shown in the dashboard (and asked aloud in voice mode) and refused if nobody
answers within JARVIS_PERMISSION_TIMEOUT seconds. Nothing is auto-approved.
"""
import collections
import itertools
import json
import os
import re
import queue
import shlex
import shutil
import subprocess
import threading
import time
import uuid

PERM_TIMEOUT = int(os.environ.get("JARVIS_PERMISSION_TIMEOUT", "90"))
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# A running tool (terminal command, browser task, scrape) sends nothing until it
# finishes, so silence while a tool runs is normal: allow much longer.
TOOL_TIMEOUT = int(os.environ.get("JARVIS_TOOL_TIMEOUT", "900"))
PROGRESS_EVERY_S = 30                 # "still working" note on the HUD during long silences
RETRY_AFTER_FAILURE_S = 120

# Hermes logs every model call on stderr, e.g.
#   agent.conversation_loop: API call #1: model=gpt-6-luna provider=opencode-zen in=13378 out=5 total=13383 latency=2.3s
# Those lines tell us how much of a turn was the model itself, and how many calls it made.
_API_CALL = re.compile(r"API call #(\d+):.*?\bin=(\d+)\b.*?\bout=(\d+)\b.*?\blatency=([\d.]+)s")


class AcpUnavailable(RuntimeError):
    """ACP could not be started or used for this turn; the caller falls back."""


def _ms(t):
    return int((time.monotonic() - t) * 1000)


def find_command(hermes_base=None):
    """Locate hermes-acp: HERMES_ACP_CMD, next to the hermes executable, on PATH,
    or in the default Windows install folder."""
    configured = os.environ.get("HERMES_ACP_CMD", "").strip()
    if configured:
        return shlex.split(configured)
    if hermes_base:
        folder, name = os.path.split(hermes_base[0])
        if name.lower() in ("hermes", "hermes.exe"):
            cand = os.path.join(folder, "hermes-acp.exe" if name.lower().endswith(".exe") else "hermes-acp")
            if os.path.isfile(cand):
                return [cand]
    found = shutil.which("hermes-acp")
    if found:
        return [found]
    if os.name == "nt":
        cand = os.path.expandvars(r"%LOCALAPPDATA%\hermes\bin\hermes-acp.exe")
        if os.path.isfile(cand):
            return [cand]
    return None


class AcpClient:
    def __init__(self, cmd, cwd, env, raw_log=None):
        self.cmd, self.cwd, self.env, self.raw_log = cmd, cwd, env, raw_log
        self.proc = None
        self.info = {}
        self.sessions = set()
        self.turn = None                      # {"session", "q", "perms"} while a prompt runs
        self.stderr = collections.deque(maxlen=200)
        self._ids = itertools.count(1)
        self._pending = {}                    # request id -> callback(msg)
        self._plock = threading.Lock()
        self._wlock = threading.Lock()
        self._start_lock = threading.Lock()
        self._spare = None
        self._spare_thread = None
        self._spare_lock = threading.Lock()

    # ── process & transport ──────────────────────────────────
    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def ensure_started(self):
        """Start hermes-acp and handshake if it isn't running. Returns ms spent."""
        with self._start_lock:
            if self.alive():
                return 0
            t = time.monotonic()
            self.sessions.clear()
            with self._spare_lock:
                self._spare = None
            try:
                self.proc = subprocess.Popen(
                    self.cmd, cwd=self.cwd, env=self.env, text=True, encoding="utf-8",
                    errors="replace", bufsize=1, stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            except OSError as e:
                raise AcpUnavailable(f"could not start {' '.join(self.cmd)}: {e}") from e
            proc = self.proc
            threading.Thread(target=self._read_stdout, args=(proc,), daemon=True).start()
            threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
            try:
                self.info = self.request("initialize", {
                    "protocolVersion": 1,
                    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                           "terminal": False},
                }, timeout=60)
            except Exception as e:
                self.stop()
                raise AcpUnavailable(f"initialize failed: {e}") from e
            return _ms(t)

    def stop(self):
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass

    def _send(self, obj):
        line = json.dumps(obj) + "\n"
        with self._wlock:
            if not self.alive():
                raise AcpUnavailable("hermes-acp is not running")
            try:
                self.proc.stdin.write(line)
                self.proc.stdin.flush()
            except OSError as e:
                raise AcpUnavailable(f"write to hermes-acp failed: {e}") from e

    def request(self, method, params, timeout=60):
        rid = next(self._ids)
        box = queue.Queue()
        with self._plock:
            self._pending[rid] = box.put
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            msg = box.get(timeout=timeout)
        except queue.Empty:
            with self._plock:
                self._pending.pop(rid, None)
            raise AcpUnavailable(f"{method} timed out after {timeout}s")
        if msg.get("_eof"):
            raise AcpUnavailable(f"hermes-acp exited during {method}")
        if "error" in msg:
            raise AcpUnavailable(f"{method} error: {json.dumps(msg['error'])[:300]}")
        return msg.get("result") or {}

    def _respond(self, rpc_id, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": rpc_id}
        msg["error" if error else "result"] = error or result or {}
        try:
            self._send(msg)
        except AcpUnavailable:
            pass

    def _read_stderr(self, proc):
        for line in proc.stderr:
            line = line.rstrip()
            turn = self.turn
            if turn is not None:
                turn["seen"] = time.monotonic()      # Hermes logging = Hermes alive
                m = _API_CALL.search(line)
                if m:
                    turn["api"].append({"at": time.monotonic(), "in": int(m.group(2)),
                                        "out": int(m.group(3)), "ms": int(float(m.group(4)) * 1000)})
            if line:
                self.stderr.append(line)
                if self.raw_log:
                    try:
                        with open(self.raw_log, "a", encoding="utf-8") as f:
                            f.write("ACP-ERR " + line + "\n")
                    except OSError:
                        pass

    def _read_stdout(self, proc):
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.stderr.append("[non-JSON stdout] " + line.rstrip()[:200])
                continue
            try:
                self._dispatch(msg)
            except Exception as e:  # noqa: BLE001 — never let the reader thread die
                self.stderr.append(f"[dispatch error] {e}")
        # process ended: release everyone waiting on it
        with self._plock:
            waiting, self._pending = list(self._pending.values()), {}
        for cb in waiting:
            cb({"_eof": True})

    def _dispatch(self, msg):
        method = msg.get("method")
        if method is None and "id" in msg:                      # a response to us
            with self._plock:
                cb = self._pending.pop(msg["id"], None)
            if cb:
                cb(msg)
            return
        turn = self.turn
        params = msg.get("params") or {}
        if method == "session/update":
            if turn and params.get("sessionId", turn["session"]) == turn["session"]:
                turn["q"].put(("update", params.get("update") or {}))
            return
        if method == "session/request_permission" and "id" in msg:
            if not turn:
                self._respond(msg["id"], {"outcome": {"outcome": "cancelled"}})
                return
            perm_id = uuid.uuid4().hex[:12]
            tc = params.get("toolCall") or {}
            options = [{"id": o.get("optionId"), "name": o.get("name") or o.get("optionId"),
                        "kind": o.get("kind") or ""} for o in params.get("options") or []]
            turn["perms"][perm_id] = {"rpc_id": msg["id"], "at": time.monotonic(), "options": options}
            turn["q"].put(("permission", {
                "id": perm_id,
                "title": str(tc.get("title") or tc.get("kind") or "use a tool")[:200],
                "options": options,
            }))
            return
        if method and "id" in msg:                              # fs/*, terminal/* etc.
            self._respond(msg["id"], error={"code": -32601, "message": f"{method} not supported by JARVIS"})

    # ── sessions ─────────────────────────────────────────────
    def new_session(self):
        res = self.request("session/new", {"cwd": self.cwd, "mcpServers": []}, timeout=180)
        sid = res.get("sessionId")
        if not sid:
            raise AcpUnavailable("session/new returned no sessionId")
        self.sessions.add(sid)
        return sid

    def take_session(self):
        """A fresh session: the pre-made spare if one is ready, else a new one."""
        with self._spare_lock:
            th = self._spare_thread
        if th is not None:
            th.join(timeout=180)
        with self._spare_lock:
            sid, self._spare = self._spare, None
        if sid and sid in self.sessions:
            return sid, 0
        t = time.monotonic()
        return self.new_session(), _ms(t)

    def refill_spare(self):
        """Prepare the next fresh session in the background (for /new and missions)."""
        with self._spare_lock:
            if self._spare or (self._spare_thread and self._spare_thread.is_alive()) or not self.alive():
                return

            def work():
                try:
                    sid = self.new_session()
                    with self._spare_lock:
                        self._spare = sid
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    with self._spare_lock:
                        self._spare_thread = None

            self._spare_thread = threading.Thread(target=work, daemon=True)
            self._spare_thread.start()

    # ── permissions & cancel ─────────────────────────────────
    def answer_permission(self, perm_id, option_id):
        turn = self.turn
        if not turn or perm_id not in turn["perms"]:
            return False
        p = turn["perms"][perm_id]
        if option_id is not None and option_id not in {o["id"] for o in p["options"]}:
            return False
        turn["perms"].pop(perm_id, None)
        outcome = ({"outcome": "selected", "optionId": option_id} if option_id
                   else {"outcome": "cancelled"})
        self._respond(p["rpc_id"], {"outcome": outcome})
        return True

    def _refuse(self, perm_id):
        turn = self.turn
        p = turn and turn["perms"].get(perm_id)
        if not p:
            return
        reject = next((o["id"] for o in p["options"] if o["kind"] == "reject_once"), None) \
            or next((o["id"] for o in p["options"] if o["kind"].startswith("reject")), None)
        self.answer_permission(perm_id, reject)

    def cancel(self):
        turn = self.turn
        if not turn:
            return False
        for pid in list(turn["perms"]):
            self.answer_permission(pid, None)
        try:
            self._send({"jsonrpc": "2.0", "method": "session/cancel",
                        "params": {"sessionId": turn["session"]}})
        except AcpUnavailable:
            pass
        return True

    def _turn_breakdown(self, timing, tools, t0):
        """Where a turn's time went, from Hermes's own log: model calls vs the rest."""
        time.sleep(0.05)                          # let the last stderr line arrive
        api = list((self.turn or {}).get("api") or [])
        timing["tool_calls"] = len(tools)
        timing["api_calls"] = len(api)
        if api:
            model_ms = sum(c["ms"] for c in api)
            timing["model_ms"] = model_ms
            timing["model_calls_ms"] = "+".join(str(c["ms"]) for c in api)
            timing["tokens_in"] = api[-1]["in"]
            timing["tokens_out"] = sum(c["out"] for c in api)
            # everything Hermes did around the model calls: tools, memory, its own bookkeeping
            timing["hermes_overhead_ms"] = max(0, timing.get("hermes_total_ms", _ms(t0)) - model_ms)

    # ── one turn ─────────────────────────────────────────────
    def prompt(self, session_id, text, timing):
        """Send one prompt; yield dashboard events until Hermes finishes."""
        q = queue.Queue()
        self.turn = {"session": session_id, "q": q, "perms": {}, "api": [], "seen": time.monotonic()}
        rid = next(self._ids)
        with self._plock:
            self._pending[rid] = lambda m: q.put(("response", m))
        t0 = last = last_ping = time.monotonic()
        first, done, tools = True, False, {}
        tool_names, last_note = {}, 0.0
        first_thought = None
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": "session/prompt",
                        "params": {"sessionId": session_id,
                                   "prompt": [{"type": "text", "text": text}]}})
            while True:
                try:
                    kind, payload = q.get(timeout=0.25)
                except queue.Empty:
                    now = time.monotonic()
                    if now - last_ping > 2:
                        # keep-alive: writing to the browser is how the server notices
                        # it has gone (Esc, tab closed) and cancels the prompt
                        last_ping = now
                        yield dict(t="ping")
                    for pid, p in list(self.turn["perms"].items()):
                        if now - p["at"] > PERM_TIMEOUT:
                            self._refuse(pid)
                            yield dict(t="note", message=f"approval not given within {PERM_TIMEOUT}s; refused")
                    running = [tool_names.get(t, "a tool") for t, st in tools.items() if st == "use"]
                    limit = TOOL_TIMEOUT if running else IDLE_TIMEOUT
                    quiet = now - max(last, self.turn.get("seen", last))
                    if quiet >= PROGRESS_EVERY_S and now - last_note >= PROGRESS_EVERY_S:
                        last_note = now
                        doing = f"running {running[-1]}" if running else "thinking"
                        yield dict(t="note", message=f"still working ({doing}) · {int(now - t0)}s so far")
                    if not self.turn["perms"] and quiet > limit:
                        self.cancel()
                        timing["hermes_total_ms"] = _ms(t0)
                        what = (f" while running {running[-1]}. Raise hermes.tool_timeout_s"
                                if running else ". Raise hermes.idle_timeout_s")
                        yield dict(t="error", timing=timing,
                                   message=f"Hermes went quiet for {limit}s{what} if this task needs longer; turn cancelled.")
                        return
                    continue
                last = time.monotonic()

                if kind == "update":
                    k = payload.get("sessionUpdate")
                    if k == "agent_message_chunk":
                        c = payload.get("content") or {}
                        txt = c.get("text") if c.get("type", "text") == "text" else ""
                        if txt:
                            if first:
                                first = False
                                timing["hermes_first_text_ms"] = _ms(t0)
                                yield dict(t="latency", ms=_ms(t0))
                            yield dict(t="delta", text=txt)
                    elif k == "agent_thought_chunk":
                        if first_thought is None:
                            first_thought = time.monotonic()
                            timing["hermes_first_thought_ms"] = _ms(t0)
                    elif k in ("tool_call", "tool_call_update"):
                        tid = payload.get("toolCallId") or uuid.uuid4().hex
                        if tid not in tools:
                            tools[tid] = "use"
                            tool_names[tid] = str(payload.get("title") or payload.get("kind") or "tool")[:120]
                            yield dict(t="tool", phase="use", name=tool_names[tid], input="")
                        status = payload.get("status")
                        if status in ("completed", "failed") and tools[tid] != "done":
                            tools[tid] = "done"
                            yield dict(t="tool", phase="done", ok=status != "failed")

                elif kind == "permission":
                    yield dict(t="permission", **payload)

                elif kind == "response":
                    done = True
                    timing["hermes_total_ms"] = _ms(t0)
                    if payload.get("_eof"):
                        yield dict(t="error", timing=timing, message="Hermes (ACP) process exited mid-turn.")
                        return
                    if "error" in payload:
                        yield dict(t="error", timing=timing,
                                   message=f"Hermes error: {json.dumps(payload['error'])[:300]}")
                        return
                    stop = (payload.get("result") or {}).get("stopReason")
                    timing["stop_reason"] = stop
                    self._turn_breakdown(timing, tools, t0)
                    if first and stop != "cancelled":
                        yield dict(t="delta", text="Hermes completed without textual output.")
                    yield dict(t="complete", session_id=session_id, ms=_ms(t0), timing=timing)
                    return
        finally:
            if not done:
                # the browser went away or the turn was abandoned: stop Hermes cleanly
                # so the session is free for the next prompt
                self.cancel()
                end = time.monotonic() + 15
                while time.monotonic() < end:
                    try:
                        kind, _ = q.get(timeout=0.25)
                    except queue.Empty:
                        if not self.alive():
                            break
                        continue
                    if kind == "response":
                        break
            with self._plock:
                self._pending.pop(rid, None)
            self.turn = None
            self.refill_spare()


# ── module-level façade used by runtime.py ───────────────────
_CLIENT = None
_CLIENT_LOCK = threading.Lock()
_FAILED_AT = 0.0
FAIL_REASON = ""


def recently_failed():
    return bool(_FAILED_AT) and time.monotonic() - _FAILED_AT < RETRY_AFTER_FAILURE_S


def mark_failed(reason):
    global _FAILED_AT, FAIL_REASON
    _FAILED_AT, FAIL_REASON = time.monotonic(), str(reason)[:300]
    if _CLIENT:
        _CLIENT.stop()


def get_client(cmd, cwd, env, raw_log=None):
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None:
            _CLIENT = AcpClient(cmd, cwd, env, raw_log)
        return _CLIENT


def has_session(sid):
    return bool(_CLIENT and _CLIENT.alive() and sid in _CLIENT.sessions)


def turn_active():
    return bool(_CLIENT and _CLIENT.turn)


def cancel():
    return bool(_CLIENT and _CLIENT.cancel())


def answer_permission(perm_id, option_id):
    return bool(_CLIENT and _CLIENT.answer_permission(perm_id, option_id))


def warm(cmd, cwd, env, raw_log=None):
    """Start hermes-acp and prepare a session in the background at server start."""
    def _w():
        try:
            c = get_client(cmd, cwd, env, raw_log)
            c.ensure_started()
            c.refill_spare()
        except Exception as e:  # noqa: BLE001
            mark_failed(e)
    threading.Thread(target=_w, daemon=True).start()


def run(cmd, cwd, env, prompt_text, session_id, timing, raw_log=None):
    """Raises AcpUnavailable before yielding anything if ACP can't be used."""
    c = get_client(cmd, cwd, env, raw_log)
    timing["acp_start_ms"] = c.ensure_started()
    if session_id and session_id in c.sessions:
        sid, timing["session_new_ms"] = session_id, 0
    else:
        sid, timing["session_new_ms"] = c.take_session()
    yield from c.prompt(sid, prompt_text, timing)