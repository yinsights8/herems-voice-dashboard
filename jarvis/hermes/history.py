"""
Read-only view of Hermes's session store (state.db, SQLite) for the HUD's chat
history: every session Hermes has had (dashboard, CLI, TUI, Discord, ...) and
their messages.

Opened with mode=ro, so the dashboard can never change Hermes's history. Hermes
keeps writing while we read; SQLite's WAL mode makes that safe.

Dashboard turns carry the persona in front of the request, which also makes
Hermes title them after the persona; both are cleaned up here for display.
"""
import json
import os
import pathlib
import re
import sqlite3

DASHBOARD_SOURCES = ("acp", "jarvis-dashboard")
_REQUEST = re.compile(r"## Current user request\s*\n(.*?)\n\s*\nAnswer the request now", re.S)
_STEER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]"
_TOOL_WRAP = re.compile(r"^\s*<untrusted_tool_result[^>]*>\s*|\s*</untrusted_tool_result>\s*$")


def db_path():
    """HERMES_STATE_DB, else state.db in HERMES_HOME, %LOCALAPPDATA%\\hermes or ~/.hermes."""
    configured = os.environ.get("HERMES_STATE_DB", "").strip()
    if configured:
        return pathlib.Path(os.path.expanduser(configured))
    homes = [os.environ.get("HERMES_HOME", "")]
    if os.name == "nt":
        homes.append(os.path.expandvars(r"%LOCALAPPDATA%\hermes"))
    homes.append(os.path.expanduser("~/.hermes"))
    for h in homes:
        if h and (pathlib.Path(h) / "state.db").is_file():
            return pathlib.Path(h) / "state.db"
    return None


def _connect():
    p = db_path()
    if not p:
        raise FileNotFoundError("Hermes session store (state.db) not found; set HERMES_STATE_DB")
    con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _clean_user(text):
    """(display text, kind) for a user row: the request without the persona, or a steer."""
    text = text or ""
    if _STEER_CLOSE in text:
        inner = text.split(_STEER_CLOSE)[0].strip().splitlines()
        while inner and ("OUT-OF-BAND" in inner[0] or inner[0].startswith("[")):
            inner.pop(0)
        return "\n".join(inner).strip(), "steer"
    m = _REQUEST.search(text)
    return (m.group(1).strip() if m else text.strip()), "user"


def _first_request(con, sid):
    row = con.execute("select content from messages where session_id=? and role='user' and active=1 "
                      "order by id limit 1", (sid,)).fetchone()
    return _clean_user(row["content"])[0] if row else ""


def list_sessions(limit=40, scope="dashboard", current=None):
    con = _connect()
    try:
        where = "archived=0 and hidden=0"
        args = []
        if scope == "dashboard":
            where += f" and source in ({','.join('?' * len(DASHBOARD_SOURCES))})"
            args += list(DASHBOARD_SOURCES)
        rows = con.execute(
            f"select id, source, title, started_at, last_activity_at, message_count, tool_call_count, model "
            f"from sessions where {where} and message_count > 0 order by coalesce(last_activity_at, started_at) desc limit ?",
            (*args, int(limit))).fetchall()
        out = []
        for r in rows:
            title = r["title"] or ""
            if r["source"] in DASHBOARD_SOURCES or not title:
                title = _first_request(con, r["id"])[:80] or title     # persona-derived titles say nothing
            out.append({"id": r["id"], "source": r["source"], "title": title or "(untitled)",
                        "started_at": r["started_at"], "last_at": r["last_activity_at"] or r["started_at"],
                        "messages": r["message_count"], "tools": r["tool_call_count"], "model": r["model"],
                        "current": r["id"] == current})
        return out
    finally:
        con.close()


def messages(sid, limit=300):
    """A session's conversation for display, oldest first. Tool output is trimmed."""
    con = _connect()
    try:
        meta = con.execute("select id, source, title from sessions where id=?", (sid,)).fetchone()
        if not meta:
            return None
        rows = con.execute(
            "select role, content, tool_name, tool_calls, timestamp, display_kind from messages "
            "where session_id=? and active=1 and role != 'system' order by id desc limit ?",
            (sid, int(limit))).fetchall()[::-1]
        out = []
        for r in rows:
            role, content = r["role"], r["content"] or ""
            if role == "user":
                text, kind = _clean_user(content)
                if r["display_kind"] and "steer" in str(r["display_kind"]).lower():
                    kind = "steer"
                out.append({"kind": kind, "text": text, "at": r["timestamp"]})
            elif role == "assistant":
                calls = []
                try:
                    for c in json.loads(r["tool_calls"] or "[]") or []:
                        fn = (c.get("function") or {}) if isinstance(c, dict) else {}
                        calls.append(fn.get("name") or c.get("name") or "tool")
                except (ValueError, TypeError, AttributeError):
                    pass
                if content.strip() or calls:
                    out.append({"kind": "assistant", "text": content.strip(), "tools": calls, "at": r["timestamp"]})
            elif role == "tool":
                body = _TOOL_WRAP.sub("", content).strip()
                if body.startswith("The following content was retrieved from an external source"):
                    body = body.split("\n", 1)[1].strip() if "\n" in body else ""   # Hermes's stock safety preamble
                out.append({"kind": "tool", "tool": r["tool_name"] or "tool",
                            "text": body[:700] + (" …" if len(body) > 700 else ""), "at": r["timestamp"]})
        title = meta["title"] or ""
        if meta["source"] in DASHBOARD_SOURCES or not title:
            title = _first_request(con, sid)[:80] or title
        return {"id": sid, "source": meta["source"], "title": title, "messages": out}
    finally:
        con.close()
