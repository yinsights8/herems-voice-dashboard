"""
Probe Hermes's ACP server: is a warm, long-running Hermes fast and streaming?

    python3 acp_probe.py
    python3 acp_probe.py C:/Users/yashd/AppData/Local/hermes/bin/hermes-acp.exe

It starts hermes-acp once, opens a session, then sends two short prompts in the
same process and prints how long each step took. The second prompt shows the
"warm" speed the dashboard would get if it kept Hermes running.

Safe: any tool-permission request from Hermes is refused, and file access
requests are declined. Nothing is installed or changed.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

DEFAULT = os.path.expandvars(r"%LOCALAPPDATA%\hermes\bin\hermes-acp.exe") if os.name == "nt" else "hermes-acp"
CMD = sys.argv[1:] or [DEFAULT]
TIMEOUT = 180

t0 = time.monotonic()
now = lambda: f"{time.monotonic() - t0:7.2f}s"

env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
try:
    proc = subprocess.Popen(CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
except FileNotFoundError:
    sys.exit(f"Could not start {CMD!r}. Pass the full path to hermes-acp.exe as an argument.")
print(f"{now()}  started {' '.join(CMD)}")

inbox = queue.Queue()
threading.Thread(target=lambda: [inbox.put(l) for l in proc.stdout], daemon=True).start()
def _err():
    for l in proc.stderr:
        if l.strip():
            print(f"{now()}  [stderr] {l.rstrip()[:160]}")
threading.Thread(target=_err, daemon=True).start()

_next = [0]
def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

turn = {}
def on_message(msg):
    """Handle anything Hermes sends that isn't the response we're waiting for."""
    method = msg.get("method")
    if method == "session/update":
        upd = (msg.get("params") or {}).get("update") or {}
        kind = upd.get("sessionUpdate", "?")
        if kind == "agent_message_chunk":
            text = ((upd.get("content") or {}).get("text")) or ""
            if "first_chunk" not in turn:
                turn["first_chunk"] = time.monotonic()
                print(f"{now()}  first answer chunk")
            turn["chunks"] = turn.get("chunks", 0) + 1
            turn["text"] = turn.get("text", "") + text
        else:
            turn.setdefault("kinds", {}).setdefault(kind, 0)
            turn["kinds"][kind] += 1
            if kind in ("tool_call", "tool_call_update"):
                print(f"{now()}  {kind}: {str(upd.get('title') or upd.get('toolCallId'))[:80]}")
    elif method == "session/request_permission" and "id" in msg:
        print(f"{now()}  permission requested -> refused (probe never allows tools)")
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": {"outcome": "cancelled"}}})
    elif method and "id" in msg:
        print(f"{now()}  agent asked for {method} -> declined")
        send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not supported by probe"}})
    elif method:
        print(f"{now()}  notification {method}")

def request(method, params):
    _next[0] += 1
    rid = _next[0]
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    start = time.monotonic()
    while time.monotonic() - start < TIMEOUT:
        if proc.poll() is not None and inbox.empty():
            sys.exit(f"hermes-acp exited with code {proc.returncode} during {method}")
        try:
            line = inbox.get(timeout=0.2)
        except queue.Empty:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            print(f"{now()}  [non-JSON stdout] {line.rstrip()[:160]}")
            continue
        if msg.get("id") == rid and ("result" in msg or "error" in msg):
            took = time.monotonic() - start
            if "error" in msg:
                print(f"{now()}  {method} FAILED after {took:.2f}s: {json.dumps(msg['error'])[:300]}")
                return None, took
            print(f"{now()}  {method} ok in {took:.2f}s")
            return msg["result"], took
        on_message(msg)
    sys.exit(f"No response to {method} within {TIMEOUT}s")

results = {}
init, results["initialize"] = request("initialize", {
    "protocolVersion": 1,
    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
})
if init is None:
    sys.exit("initialize failed; paste this output to Claude.")
print(f"           agent info: {json.dumps(init)[:400]}")

sess, results["session/new"] = request("session/new", {"cwd": os.getcwd(), "mcpServers": []})
if not sess or "sessionId" not in sess:
    sys.exit("session/new failed; paste this output to Claude.")
sid = sess["sessionId"]

for label, text in (("cold prompt", "Say online, nothing else."), ("warm prompt", "Say online again, nothing else.")):
    turn = {}
    t = time.monotonic()
    res, took = request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
    fc = turn.get("first_chunk")
    results[label] = took
    results[label + " first chunk"] = (fc - t) if fc else None
    print(f"           {label}: stop={((res or {}).get('stopReason'))} chunks={turn.get('chunks', 0)} "
          f"other updates={turn.get('kinds', {})} text={turn.get('text', '').strip()[:80]!r}")

print("\nSUMMARY (seconds)")
for k, v in results.items():
    print(f"  {k:<26} {'-' if v is None else f'{v:.2f}'}")
print("\nCompare 'warm prompt' with the 13.8 s cold `hermes chat`. Paste this whole output to Claude.")
proc.terminate()