"""
Hermes runtime for the JARVIS HUD.

This dashboard is a face on Hermes Agent, not Claude Code. It launches the
Hermes CLI with the selected profile/source so Hermes keeps access to the same
configured toolsets, MCP servers, browser automation, Google integrations,
third-party tools, skills, memory, and gateway features that are available to the
normal Hermes agent.

Set HERMES_CMD when your shell exposes Hermes under a custom command/path, e.g.
  HERMES_CMD="/path/to/hermes"
or
  HERMES_CMD="python3 -m hermes_cli.main"
"""
import collections
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time

from jarvis.hermes import acp as acp_runtime

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CLI_NOISE = re.compile(
    r"^(?:Query:|Initializing agent|Resume this session with:|hermes --resume\b|"
    r"Session:|Duration:|Messages:|─+|=+|[-─ ]*⚕\s*Hermes\b)", re.I)
# Hermes status notices that can appear anywhere in a line, after any glyph
# (↪ ⤷ ↳ → …). They are runtime chatter, never part of the answer.
_HERMES_NOTICE = re.compile(r"restored workspace dir", re.I)

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
PROFILE = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default")).strip() or "default"
SOURCE = os.environ.get("HERMES_SOURCE", "jarvis-dashboard").strip() or "jarvis-dashboard"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = os.environ.get("JARVIS_PERMISSION", os.environ.get("HERMES_PERMISSION", "normal")).strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|hermes|mock
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# `hermes chat -Q` prints nothing while tools run, so the CLI path can't tell a
# long tool from a hang: it uses the (longer) tool limit.
TOOL_TIMEOUT = int(os.environ.get("JARVIS_TOOL_TIMEOUT", "900"))
# Raw transcripts can contain private prompts. Logging is off by default.
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()
TOOLSETS = os.environ.get("HERMES_TOOLSETS", "").strip()
# auto: keep one hermes-acp process running when possible (fast), else per-turn
# `hermes chat`. acp: always ACP. cli: always per-turn `hermes chat`.
HERMES_MODE = os.environ.get("JARVIS_HERMES_MODE", "auto").strip().lower()

# One Hermes subprocess at a time. Hermes session state and profile resources are
# shared, so foreground runs and /background missions must not overlap. The active
# process handle lets the browser Escape key stop the backend work, not just the
# frontend fetch.
EXECUTION_LOCK = threading.RLock()
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()


def cancel_active():
    """Stop the current turn: cancel the ACP prompt, or terminate the CLI process."""
    if acp_runtime.turn_active():
        return acp_runtime.cancel()
    with _ACTIVE_LOCK:
        proc = _ACTIVE_PROC
    if proc is None or proc.poll() is not None:
        return False
    try:
        proc.terminate()
        return True
    except Exception:
        return False


def valid_session(sid):
    # Hermes emits timestamp-based IDs such as 20260808_031038_0ecb14.
    return bool(sid) and bool(_SESSION_ID.match(str(sid)))


def _mono_ms():
    return int(time.monotonic() * 1000)


def _hermes_base():
    configured = os.environ.get("HERMES_CMD", "").strip()
    if configured:
        return shlex.split(configured)
    exe = shutil.which("hermes")
    if exe:
        return [exe]
    if os.name == "nt":
        # A `hermes` shell-script shim works in Git Bash but can't be launched
        # by Python; the venv's hermes.exe can. Look beside the running Python.
        for d in (os.path.dirname(sys.executable), os.path.join(os.path.dirname(sys.executable), "Scripts")):
            cand = os.path.join(d, "hermes.exe")
            if os.path.isfile(cand):
                return [cand]
        return [sys.executable, "-m", "hermes_cli.main"]
    # Last-resort module invocation; start.sh prepends common Python bin dirs.
    return ["python3", "-m", "hermes_cli.main"]


def _can_launch_hermes():
    base = []
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["--version"], cwd=WORKDIR, text=True,
                              encoding="utf-8", errors="replace",
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=12)
        out = (proc.stdout or proc.stderr).strip()
        if proc.returncode == 0:
            return True, out
        return False, (f"`{' '.join(base)} --version` exited with code {proc.returncode}"
                       + (f": {out}" if out else " and printed nothing"))
    except Exception as e:  # noqa: BLE001
        return False, f"could not run `{' '.join(base) or 'hermes'}`: {type(e).__name__}: {e}"


# Each `hermes ...` subprocess costs seconds to start (on Windows 2-4 s), so the
# availability check and the tool list are computed once and reused instead of
# being re-run on every turn. A failed check is not cached, so it retries.
_KIND_CACHE = None
_TOOLS_CACHE = None
_CACHE_LOCK = threading.Lock()


def runtime_kind(refresh=False):
    global _KIND_CACHE
    if RUNTIME == "mock":
        return "mock"
    if RUNTIME == "hermes":
        return "hermes"
    if _KIND_CACHE == "hermes" and not refresh:
        return "hermes"
    ok, _ = _can_launch_hermes()
    _KIND_CACHE = "hermes" if ok else None
    return "hermes" if ok else "mock"


def acp_command():
    return acp_runtime.find_command(_hermes_base())


def use_acp():
    """Should this turn go through the persistent hermes-acp process?"""
    if HERMES_MODE == "cli":
        return False
    if HERMES_MODE == "acp":
        return acp_command() is not None
    # auto: only when nothing CLI-only is configured (ACP takes no --profile,
    # --model or --toolsets), and not straight after a failure.
    return (acp_command() is not None and PROFILE == "default" and not MODEL
            and not TOOLSETS and not acp_runtime.recently_failed())


def mode_label():
    if not use_acp():
        return "cli (hermes chat per turn)"
    return "acp (persistent hermes-acp)"


def session_usable(sid):
    """Can this session id be resumed by the runtime the next turn will use?"""
    if not sid:
        return False
    if use_acp():
        return acp_runtime.has_session(sid)
    return valid_session(sid)


def answer_permission(perm_id, option_id):
    return acp_runtime.answer_permission(perm_id, option_id)


def warm_caches():
    """Run the slow Hermes checks once, in the background, at server start.
    In ACP mode also start hermes-acp and prepare a session, so the first turn
    doesn't pay Hermes's 10 s start-up."""
    def _warm():
        if runtime_kind() == "hermes":
            if use_acp():
                acp_runtime.warm(acp_command(), WORKDIR, _child_env(), RAW_LOG or None)
            hermes_tools_snapshot(refresh=True)
    threading.Thread(target=_warm, daemon=True).start()


def refresh_caches():
    """Re-check Hermes and its tools (after /new, when tools may have changed)."""
    global _KIND_CACHE, _TOOLS_CACHE
    _KIND_CACHE = None
    with _CACHE_LOCK:
        _TOOLS_CACHE = None
    warm_caches()


def compose_prompt(message, system=None):
    # Hermes has no separate system-prompt input here. Put the voice persona and
    # the current request into one explicit turn so the model answers as JARVIS
    # instead of narrating its runtime.
    if not system:
        return message
    return (f"{system}\n\n## Current user request\n{message}\n\n"
            f"Answer the request now. Return only the words {os.environ.get('ASSISTANT_NAME') or 'Jarvis'} should say aloud; "
            "never include session IDs, runtime metadata, headings, or process narration.")


def build_command(message, session_id=None, system=None):
    # Quiet mode removes the Hermes banner.
    prompt = compose_prompt(message, system)
    cmd = _hermes_base() + ["chat", "-Q", "-q", prompt, "--source", SOURCE]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    if PROFILE and PROFILE != "default":
        cmd += ["--profile", PROFILE]
    if MODEL:
        cmd += ["--model", MODEL]
    if TOOLSETS:
        cmd += ["--toolsets", TOOLSETS]
    # Hermes one-shot output is currently plain text; slash commands that need a
    # live TUI are handled in commands.py before we get here. Prompts go to the
    # real agent with normal tool access.
    return cmd


def hermes_tools_snapshot(limit=36, refresh=False):
    """Return a compact list of enabled/visible Hermes toolsets/tools for UI status.
    Cached after the first call; pass refresh=True to re-run `hermes tools list`."""
    global _TOOLS_CACHE
    with _CACHE_LOCK:
        if _TOOLS_CACHE is not None and not refresh:
            return list(_TOOLS_CACHE)
        tools = _list_tools(limit)
        if tools:
            _TOOLS_CACHE = tools
        return list(tools)


def cached_tool_count():
    """Tool count for a turn's status line, without ever waiting: the list is
    filled in the background at start-up (`hermes tools list` takes seconds),
    and a turn shows 0 until it's ready rather than stalling on it."""
    cache = _TOOLS_CACHE
    return len(cache) if cache else 0


def _list_tools(limit):
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["tools", "list"], cwd=WORKDIR, text=True,
                              encoding="utf-8", errors="replace", env=_child_env(),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=20)
        out = (proc.stdout or proc.stderr or "").strip()
        tools = []
        for line in out.splitlines():
            clean = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if not clean or clean.startswith(("Usage", "─", "=")):
                continue
            if any(tok in clean.lower() for tok in ("enabled", "available", "tool", "browser", "terminal", "file", "google", "github", "web", "voice")):
                tools.append(clean[:80])
            if len(tools) >= limit:
                break
        return tools or [out[:120]] if out else []
    except Exception:
        return []


def _child_env():
    env = dict(os.environ)
    # Hermes is Python too: make it write UTF-8 to our pipes on every OS.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    # Ensure GUI-started shells can still find common Homebrew/user installs.
    home = os.path.expanduser("~")
    extra = [os.path.join(home, ".local", "bin"), os.path.join(home, ".npm-global", "bin")]
    if os.name != "nt":
        extra += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    env["PATH"] = os.pathsep.join(dict.fromkeys([env.get("PATH", ""), *extra]))
    return env


def run_hermes(message, session_id=None, system=None, timing=None):
    timing = timing if timing is not None else {}
    t = time.monotonic()
    with EXECUTION_LOCK:
        # time spent waiting behind another run (e.g. a /background mission)
        timing["lock_wait_ms"] = _since(t)
        yield from _run_hermes_locked(message, session_id, system, timing)


def _since(t):
    return int((time.monotonic() - t) * 1000)


def _run_hermes_locked(message, session_id=None, system=None, timing=None):
    global _ACTIVE_PROC
    timing = timing if timing is not None else {}
    started = _mono_ms()
    cmd = build_command(message, session_id, system)
    t = time.monotonic()
    tool_count = cached_tool_count()
    timing["tools_snapshot_ms"] = _since(t)
    yield dict(t="status", model=MODEL or "Hermes default", tools=tool_count,
               mcp=[], permission=PERMISSION, profile=PROFILE, runtime="hermes",
               session_id=session_id)

    child_env = _child_env()

    t_spawn = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, cwd=WORKDIR, text=True, bufsize=1,
                                encoding="utf-8", errors="replace",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=child_env)
        timing["spawn_ms"] = _since(t_spawn)
        with _ACTIVE_LOCK:
            _ACTIVE_PROC = proc
    except FileNotFoundError:
        raise RuntimeError("Hermes CLI not found. Set HERMES_CMD to your Hermes executable.")

    q = collections.deque()
    lock = threading.Lock()
    done = threading.Event()
    errbuf = collections.deque(maxlen=120)
    seen = [time.monotonic()]
    raw = None
    if RAW_LOG:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(os.path.expanduser(RAW_LOG), flags, 0o600)
        if hasattr(os, "fchmod"):          # not available on Windows
            os.fchmod(fd, 0o600)
        raw = os.fdopen(fd, "w", encoding="utf-8", errors="replace")
        raw.write("$ " + " ".join(shlex.quote(x) for x in cmd) + "\n\n")
        raw.flush()

    def pump_stdout():
        try:
            for ln in proc.stdout:
                if raw:
                    raw.write("OUT " + ln); raw.flush()
                with lock:
                    q.append((time.monotonic(), ln))
        finally:
            done.set()

    def pump_stderr():
        try:
            for ln in proc.stderr:
                if raw:
                    raw.write("ERR " + ln); raw.flush()
                if "hermes_first_stderr_ms" not in timing:
                    timing["hermes_first_stderr_ms"] = _since(t_spawn)
                errbuf.append(ln.rstrip())
                seen[0] = time.monotonic()
        except Exception:
            pass

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    first = True
    last = time.monotonic()
    text_seen = False
    emitted_session = None
    try:
        while not done.is_set() or q:
            line = None
            with lock:
                if q:
                    arrived, line = q.popleft()
                    if "hermes_first_output_ms" not in timing:
                        timing["hermes_first_output_ms"] = int((arrived - t_spawn) * 1000)
            if line is None:
                if proc.poll() is not None and done.is_set():
                    break
                limit = max(IDLE_TIMEOUT, TOOL_TIMEOUT)
                if time.monotonic() - max(last, seen[0]) > limit:
                    proc.kill()
                    err = " | ".join(list(errbuf)[-3:])
                    timing["hermes_total_ms"] = _since(t_spawn)
                    yield dict(t="error", timing=timing,
                               message=(f"Hermes went quiet for {limit}s and was stopped. " + err)[:400])
                    return
                time.sleep(0.05)
                continue
            last = time.monotonic()
            clean = _ANSI.sub("", line).strip()
            if not clean:
                continue
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", clean, re.I)
            if session_match:
                candidate = session_match.group(1)
                if valid_session(candidate):
                    emitted_session = candidate
                continue
            # Be defensive when an older Hermes build ignores quiet mode.
            if _CLI_NOISE.match(clean) or _HERMES_NOTICE.search(clean):
                continue
            if first:
                first = False
                timing["hermes_first_text_ms"] = int((arrived - t_spawn) * 1000)
                yield dict(t="latency", ms=_mono_ms() - started)
            text_seen = True
            yield dict(t="delta", text=clean + "\n")

        rc = proc.wait(timeout=5)
        timing["hermes_total_ms"] = _since(t_spawn)
        # Hermes writes its programmatic session_id marker to stderr in quiet
        # mode, so capture it there without exposing it as response text.
        for errline in errbuf:
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", errline.strip(), re.I)
            if session_match and valid_session(session_match.group(1)):
                emitted_session = session_match.group(1)
        if rc != 0:
            err = " | ".join(list(errbuf)[-6:])
            yield dict(t="error", timing=timing, message=(err or f"Hermes exited with code {rc}")[:500])
            return
        if not text_seen:
            yield dict(t="delta", text="Hermes completed without textual output.")
        yield dict(t="complete", session_id=emitted_session or session_id,
                   ms=_mono_ms() - started, timing=timing)
    finally:
        try:
            if raw:
                raw.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        with _ACTIVE_LOCK:
            if _ACTIVE_PROC is proc:
                _ACTIVE_PROC = None


def run_mock(message, session_id=None, system=None):
    ok, detail = _can_launch_hermes()
    yield dict(t="error", message=("Hermes is not reachable from this dashboard process. "
                                  "Set HERMES_CMD or start from a shell where `hermes` works. "
                                  f"Diagnostic: {detail[:240]}"))


def run(message, session_id=None, system=None, timing=None, full_system=None):
    """timing, if given, is filled in place with per-stage durations (ms):
    probe_ms, lock_wait_ms, tools_snapshot_ms, spawn_ms,
    hermes_first_output_ms / hermes_first_text_ms / hermes_first_stderr_ms
    (measured from process spawn), hermes_total_ms."""
    timing = timing if timing is not None else {}
    t = time.monotonic()
    kind = runtime_kind()
    timing["probe_ms"] = _since(t)          # `hermes --version` check
    if kind != "hermes":
        yield from run_mock(message, session_id, system)
        return
    if use_acp():
        t = time.monotonic()
        with EXECUTION_LOCK:
            timing["lock_wait_ms"] = _since(t)
            timing["mode"] = "acp"
            yield dict(t="status", model=MODEL or "Hermes default",
                       tools=cached_tool_count(), mcp=[], permission=PERMISSION,
                       profile=PROFILE, runtime="hermes-acp", session_id=session_id)
            gen = acp_runtime.run(acp_command(), WORKDIR, _child_env(),
                                  compose_prompt(message, system), session_id, timing,
                                  RAW_LOG or None)
            try:
                first = next(gen)                # starts hermes-acp / session if needed
            except StopIteration:
                return
            except acp_runtime.AcpUnavailable as e:
                acp_runtime.mark_failed(e)
                first = None
                fallback_note = f"ACP unavailable ({str(e)[:120]}); using hermes chat for now"
            if first is not None:
                yield first
                yield from gen
                return
        # ACP failed before producing anything: fall back to the CLI for this turn
        yield dict(t="note", message=fallback_note)
        timing["mode"] = "cli-fallback"
        session_id = None                    # an ACP session id means nothing to the CLI
        system = system or full_system       # new CLI session: it needs the persona
    else:
        timing["mode"] = "cli"
    try:
        yield from run_hermes(message, session_id, system, timing)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")